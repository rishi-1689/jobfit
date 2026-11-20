// admin Lambda - backs everything under /admin.
//
// One consolidated function handling 5 routes (dispatched on
// event.routeKey), not 5 separate least-privilege Lambdas like the rest of
// this API. That's a deliberate departure from the per-Lambda pattern used
// everywhere else in this project: the per-function least-privilege split
// makes sense when many different UNTRUSTED callers each need access to
// one narrow thing. Here there's exactly one trusted human (an "Admins"
// group member) calling every route, so splitting into 5 functions would
// just be 5x the CloudFormation boilerplate for the same effective
// permission set, without actually narrowing what any single caller can
// do. Deployed via `aws cloudformation package` (see api-stack.yaml), not
// inline `ZipFile` - handling 5 routes is comfortably past the
// 4096-character inline limit.
//
// Authorization: every request must carry a verified JWT (the API
// Gateway JWT authorizer already guarantees that, same as every other
// route), AND that token's `cognito:groups` claim must list "Admins".
// HTTP API JWT authorizers can only check the token itself (signature,
// expiry, audience) - they can't run custom logic like "is this user in a
// group" - so that check happens here, inside the Lambda, the same way
// every other Lambda in this project makes its own authorization decisions
// (e.g. "does this applicationId belong to this caller's own userId").

const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { SSMClient, GetParameterCommand, PutParameterCommand } = require("@aws-sdk/client-ssm");
const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});
const cognito = new CognitoIdentityProviderClient({});

const PROFILES_TABLE = process.env.PROFILES_TABLE;
const USER_POOL_ID = process.env.USER_POOL_ID;
const AI_API_KEY_PARAM = process.env.AI_API_KEY_PARAM;
const USE_LIVE_AI_PARAM = process.env.USE_LIVE_AI_PARAM;
const DEFAULT_QUOTA = Number(process.env.DEFAULT_QUOTA || "10");

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function isAdmin(event) {
  // API Gateway's HTTP API JWT authorizer exposes every claim as a plain
  // string, including array-valued ones like cognito:groups - so this is a
  // substring check, not an array membership check. Safe as long as no
  // OTHER group name ever contains "Admins" as a substring (only "Admins"
  // itself exists in this pool right now).
  const groups = (event.requestContext.authorizer.jwt.claims["cognito:groups"] || "");
  return groups.includes("Admins");
}

// ---------------------------------------------------------------------------
// GET/PUT /admin/settings - the live-AI toggle, and whether a real API key
// is configured (never the key's actual value).
// ---------------------------------------------------------------------------
async function getSettings() {
  const useLiveAiRes = await ssm
    .send(new GetParameterCommand({ Name: USE_LIVE_AI_PARAM }))
    .catch(() => null);

  // Never decrypt the key just to check a boolean. SSM bumps a parameter's
  // Version every time it's overwritten (it starts at 1) - the deploy
  // bootstrap creates it once with a placeholder, so Version > 1 means an
  // admin has actually set a real key since then.
  const apiKeyRes = await ssm
    .send(new GetParameterCommand({ Name: AI_API_KEY_PARAM }))
    .catch(() => null);

  return json(200, {
    useLiveAI: !!(useLiveAiRes && useLiveAiRes.Parameter.Value === "true"),
    apiKeyConfigured: !!(apiKeyRes && apiKeyRes.Parameter.Version > 1),
  });
}

async function putSettings(event) {
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    // fall through to the validation check below
  }
  if (typeof body.useLiveAI !== "boolean") {
    return json(400, { message: "useLiveAI (boolean) is required" });
  }

  await ssm.send(
    new PutParameterCommand({
      Name: USE_LIVE_AI_PARAM,
      Type: "String",
      Value: body.useLiveAI ? "true" : "false",
      Overwrite: true,
    }),
  );

  return json(200, { useLiveAI: body.useLiveAI });
}

// ---------------------------------------------------------------------------
// PUT /admin/api-key - write-only. The key is never read back by any route.
// ---------------------------------------------------------------------------
async function putApiKey(event) {
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    // fall through
  }
  const apiKey = (body.apiKey || "").trim();
  if (!apiKey) {
    return json(400, { message: "apiKey is required" });
  }

  // Unlike CloudFormation's AWS::SSM::Parameter (which cannot create a
  // SecureString - a real limitation of that resource type), the SSM API
  // itself has always supported it directly, which is exactly what this
  // does: the key is encrypted at rest from the moment it's written.
  await ssm.send(
    new PutParameterCommand({
      Name: AI_API_KEY_PARAM,
      Type: "SecureString",
      Value: apiKey,
      Overwrite: true,
    }),
  );

  return json(200, { apiKeyConfigured: true });
}

// ---------------------------------------------------------------------------
// GET /admin/users - every signed-up user, with their submission count and
// effective quota.
// ---------------------------------------------------------------------------
async function getUsers() {
  // Cognito, not UserProfiles, is the source of truth for "who are my
  // users": UserProfiles only gets a row once someone uploads a resume or
  // submits a JD, so a brand-new signup with neither wouldn't show up at
  // all if this started from UserProfiles instead.
  const cognitoUsers = [];
  let paginationToken;
  do {
    const res = await cognito.send(
      new ListUsersCommand({ UserPoolId: USER_POOL_ID, PaginationToken: paginationToken }),
    );
    for (const u of res.Users || []) {
      const attrs = Object.fromEntries((u.Attributes || []).map((a) => [a.Name, a.Value]));
      cognitoUsers.push({ userId: attrs.sub, email: attrs.email, name: attrs.name });
    }
    paginationToken = res.PaginationToken;
  } while (paginationToken);

  // A Scan (not a Query) is the right call here: this is an admin-only,
  // low-frequency, whole-table read - nothing like the per-user Query
  // pattern the user-facing list-applications Lambda uses on every page
  // load. Fine at this table's size; would need a different approach
  // (e.g. a GSI) if this table ever grew to real production scale.
  const profiles = await ddb.send(new ScanCommand({ TableName: PROFILES_TABLE }));
  const profileById = new Map((profiles.Items || []).map((i) => [i.userId.S, i]));

  const users = cognitoUsers.map((u) => {
    const p = profileById.get(u.userId);
    return {
      userId: u.userId,
      email: u.email,
      name: u.name,
      applicationCount: p && p.applicationCount ? Number(p.applicationCount.N) : 0,
      // null vs a number distinguishes "using the global default" from "an
      // admin explicitly set this user's own quota" in the UI.
      applicationQuota: p && p.applicationQuota ? Number(p.applicationQuota.N) : null,
      effectiveQuota: p && p.applicationQuota ? Number(p.applicationQuota.N) : DEFAULT_QUOTA,
    };
  });

  return json(200, { users, defaultQuota: DEFAULT_QUOTA });
}

// ---------------------------------------------------------------------------
// PUT /admin/users/{userId}/quota
// ---------------------------------------------------------------------------
async function putUserQuota(event) {
  const userId = event.pathParameters && event.pathParameters.userId;
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    // fall through
  }
  const quota = Number(body.quota);
  if (!userId || !Number.isFinite(quota) || quota < 0) {
    return json(400, { message: "A non-negative quota is required" });
  }

  // An upsert is correct here (unlike update-application's editing flow):
  // the admin is deliberately configuring a specific userId they just saw
  // in GET /admin/users, including possibly a user who has no UserProfiles
  // row yet at all - there's nothing to "not find".
  await ddb.send(
    new UpdateItemCommand({
      TableName: PROFILES_TABLE,
      Key: { userId: { S: userId } },
      UpdateExpression: "SET applicationQuota = :q",
      ExpressionAttributeValues: { ":q": { N: String(quota) } },
    }),
  );

  return json(200, { userId, applicationQuota: quota });
}

exports.handler = async (event) => {
  if (!isAdmin(event)) {
    return json(403, { message: "Admins only" });
  }

  switch (event.routeKey) {
    case "GET /admin/settings":
      return getSettings();
    case "PUT /admin/settings":
      return putSettings(event);
    case "PUT /admin/api-key":
      return putApiKey(event);
    case "GET /admin/users":
      return getUsers();
    case "PUT /admin/users/{userId}/quota":
      return putUserQuota(event);
    default:
      return json(404, { message: "Not found" });
  }
};
