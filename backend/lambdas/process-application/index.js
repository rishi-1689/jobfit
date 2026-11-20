// process-application Lambda
//
// Triggered by SQS (batch size 1) after create-application publishes a
// message. For each message:
//   1. Marks the application PROCESSING.
//   2. Looks up the user's current resume (UserProfiles.currentResumeS3Key).
//   3. Extracts text from it (PDF via Amazon Textract; see the note below
//      on why DOCX isn't handled the same way).
//   4. Runs either the deterministic keyword-overlap matcher, or - if
//      USE_LIVE_AI is "true" - a (currently stubbed) live AI call, with an
//      automatic fallback to the deterministic path if that call fails.
//   5. Writes the generated cover letter to S3 and updates the
//      JobApplications row: status=DONE, matchScore, gapAnalysis,
//      coverLetterS3Key.
//
// This file is deployed via `aws cloudformation package` (see
// infrastructure/cloudformation/processing-stack.yaml), NOT the inline
// `ZipFile` trick the other three Lambdas use - this one is comfortably
// past CloudFormation's 4096-character inline-code limit.
//
// Like every other Lambda in this project, it relies on the AWS SDK v3
// being pre-installed in the Node.js managed runtime - no package.json,
// no node_modules, nothing to npm install.

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const {
  TextractClient,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
} = require("@aws-sdk/client-textract");

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});
const textract = new TextractClient({});

const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;
const PROFILES_TABLE = process.env.PROFILES_TABLE;
const APPLICATIONS_TABLE = process.env.APPLICATIONS_TABLE;
const AI_API_KEY_PARAM = process.env.AI_API_KEY_PARAM;
const USE_LIVE_AI_PARAM = process.env.USE_LIVE_AI_PARAM;
const MAX_RECEIVES = parseInt(process.env.MAX_RECEIVE_COUNT || "3", 10);

// ---------------------------------------------------------------------------
// Text extraction
//
// Genuine PDF text extraction without a bundled library (pdf-parse, etc. -
// none of which are part of the Lambda-managed SDK, so using them would mean
// building and maintaining a real dependency bundle) is exactly what Amazon
// Textract does, using only an AWS SDK call - no new build tooling,
// consistent with every other Lambda in this project.
//
// Textract has two APIs for this: the synchronous DetectDocumentText only
// accepts a SINGLE-PAGE PDF (or an image) - a real multi-page resume gets
// rejected outright with UnsupportedDocumentException. The asynchronous
// pair below (Start.../Get...DocumentTextDetection) handles multi-page PDFs
// (up to 3000 pages) instead: kick the job off, then poll for completion.
// Real Textract jobs for a document this small typically finish in a few
// seconds, so polling inside the same Lambda invocation - rather than the
// "textbook" SNS-notification pattern - keeps this a single Lambda with no
// new AWS resources, at the cost of a bigger Timeout (see
// processing-stack.yaml) to leave room for polling.
//
// DOCX is a different problem: a .docx is a ZIP archive containing XML, and
// there is no equivalent AWS-managed, SDK-only way to read one. A from-
// scratch ZIP+XML parser is real, fiddly binary-format code that I can't
// safely hand-test before it's live in a Lambda handling real user uploads -
// exactly the kind of thing that risks the "don't crash" priority for this
// phase. So: PDFs get real extraction; anything else degrades gracefully
// (see extractResumeText's null case below) rather than silently producing
// garbage from misread bytes. A follow-up phase could add a Lambda Layer
// with a real DOCX library if that's worth the added build step.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Leaves headroom under the Lambda's own Timeout (90s) for the rest of the
// work (DynamoDB, S3, matching) - not the whole budget.
const TEXTRACT_POLL_BUDGET_MS = 60000;
const TEXTRACT_POLL_INTERVAL_MS = 2000;

function blocksToText(blocks) {
  return (blocks || [])
    .filter((b) => b.BlockType === "LINE")
    .map((b) => b.Text || "")
    .join("\n");
}

async function extractResumeText(bucket, key) {
  const ext = (key.split(".").pop() || "").toLowerCase();
  if (ext !== "pdf") return null;

  const start = await textract.send(
    new StartDocumentTextDetectionCommand({
      DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
    }),
  );
  const jobId = start.JobId;

  const deadline = Date.now() + TEXTRACT_POLL_BUDGET_MS;
  let result;
  do {
    await sleep(TEXTRACT_POLL_INTERVAL_MS);
    result = await textract.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
    if (result.JobStatus === "FAILED") {
      throw new Error(`Textract job failed: ${result.StatusMessage || "unknown reason"}`);
    }
  } while (result.JobStatus !== "SUCCEEDED" && Date.now() < deadline);

  if (!result || result.JobStatus !== "SUCCEEDED") {
    throw new Error("Textract job did not finish within the polling budget");
  }

  // Results are paginated for longer documents.
  let text = blocksToText(result.Blocks);
  let nextToken = result.NextToken;
  while (nextToken) {
    const page = await textract.send(
      new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }),
    );
    text += "\n" + blocksToText(page.Blocks);
    nextToken = page.NextToken;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Deterministic matching (USE_LIVE_AI=false, the default, and the automatic
// fallback if the live AI path throws)
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "to",
  "of", "in", "on", "at", "by", "with", "from", "as", "is", "are", "was",
  "were", "be", "been", "being", "this", "that", "these", "those", "it",
  "its", "you", "your", "we", "our", "they", "their", "will", "would",
  "can", "could", "should", "shall", "may", "might", "must", "have", "has",
  "had", "do", "does", "did", "not", "no", "yes", "so", "than", "too",
  "very", "also", "into", "about", "over", "under", "per", "etc",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9+.#\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function buildCoverLetter(matchScore, gapAnalysis) {
  const gapLine = gapAnalysis.length
    ? `Areas I would highlight further in an interview include: ${gapAnalysis.join(", ")}.`
    : "My background appears to align closely with the terms in this job description.";
  return [
    "Dear Hiring Manager,",
    "",
    `I am excited to apply for this position. An automated review found my resume aligns with approximately ${matchScore}% of the key terms in your job description.`,
    "",
    gapLine,
    "",
    "I look forward to discussing how my experience can contribute to your team.",
    "",
    "Sincerely,",
    "A JobFit Copilot applicant",
  ].join("\n");
}

function deterministicMatch(resumeText, jdText) {
  const jdWords = new Set(tokenize(jdText));
  const resumeWords = new Set(tokenize(resumeText));

  let hitCount = 0;
  const missing = [];
  for (const w of jdWords) {
    if (resumeWords.has(w)) hitCount++;
    else missing.push(w);
  }

  const matchScore =
    jdWords.size === 0 ? 0 : Math.round((hitCount / jdWords.size) * 100);
  const gapAnalysis = missing.sort().slice(0, 15);

  return {
    matchScore,
    gapAnalysis,
    coverLetterText: buildCoverLetter(matchScore, gapAnalysis),
  };
}

// ---------------------------------------------------------------------------
// Live AI path - stubbed for now. Both the on/off switch and the API key
// live in SSM Parameter Store, not an env var: an admin (see /admin,
// api-stack.yaml's AdminFunction) changes them at runtime through the app
// itself, with no redeploy - so this Lambda has to read them fresh on
// every invocation rather than trust whatever was baked in at deploy time.
// It's a single global switch for the whole app, not a per-application
// choice.
// ---------------------------------------------------------------------------
async function getUseLiveAI() {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: USE_LIVE_AI_PARAM }));
    return (res.Parameter && res.Parameter.Value) === "true";
  } catch (err) {
    // ParameterNotFound (bootstrap hasn't run yet) or any other read
    // failure: fail closed to the deterministic matcher rather than throw
    // and fail the whole application over a missing feature-flag setting.
    console.error("Could not read USE_LIVE_AI_PARAM, defaulting to false:", err);
    return false;
  }
}

async function getAiApiKey() {
  const res = await ssm.send(
    new GetParameterCommand({ Name: AI_API_KEY_PARAM, WithDecryption: true }),
  );
  return res.Parameter && res.Parameter.Value;
}

// eslint-disable-next-line no-unused-vars
async function callAIProvider(resumeText, jdText, apiKey) {
  // TODO: wire in real LLM API call here (Gemini) once a working key is
  // confirmed in SSM. Until then this always throws, which is intentional:
  // processRecord() below catches that and falls back to the deterministic
  // matcher, so flipping USE_LIVE_AI on before this is implemented degrades
  // safely instead of failing every application.
  throw new Error("callAIProvider is not implemented yet");
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
//
// Both writes below are guarded with a ConditionExpression and treat a
// ConditionalCheckFailedException as a benign no-op, not an error. Two
// races this now protects against, both newly possible now that
// applications can be edited/deleted while a processing run is in flight:
//   - DELETE /applications/{id} runs mid-processing: attribute_exists
//     stops this Lambda's UpdateItem from silently CREATING a new,
//     incomplete row where the deleted one used to be (DynamoDB's default
//     UpdateItem behavior is an upsert).
//   - PUT /applications/{id} (edit) runs mid-processing: finish()'s extra
//     jobDescription match check stops a slow run - working from the OLD
//     text - from overwriting the fresher PENDING/DONE state the edit (and
//     its own, newer processing run) already produced.
// ---------------------------------------------------------------------------
async function updateIfStillCurrent(userId, applicationId, updateExpression, names, values, extraCondition) {
  const condition = extraCondition
    ? `attribute_exists(applicationId) AND ${extraCondition}`
    : "attribute_exists(applicationId)";
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: APPLICATIONS_TABLE,
        Key: { userId: { S: userId }, applicationId: { S: applicationId } },
        ConditionExpression: condition,
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if (err && err.name === "ConditionalCheckFailedException") {
      console.log(`Skipped a stale write for ${applicationId} - it was deleted or edited since this run started.`);
      return;
    }
    throw err;
  }
}

async function setStatus(userId, applicationId, status, extra) {
  const names = { "#s": "status" };
  const values = { ":s": { S: status } };
  let expr = "SET #s = :s";
  for (const [k, v] of Object.entries(extra || {})) {
    names[`#${k}`] = k;
    values[`:${k}`] = { S: String(v) };
    expr += `, #${k} = :${k}`;
  }
  await updateIfStillCurrent(userId, applicationId, expr, names, values);
}

async function finish(userId, applicationId, expectedJobDescription, { matchScore, gapAnalysis, coverLetterS3Key }) {
  const names = { "#s": "status" };
  const values = {
    ":done": { S: "DONE" },
    ":score": { N: String(matchScore) },
    ":gaps": { L: (gapAnalysis || []).map((g) => ({ S: g })) },
    ":expectedJD": { S: expectedJobDescription },
  };
  let expr = "SET #s = :done, matchScore = :score, gapAnalysis = :gaps";
  if (coverLetterS3Key) {
    expr += ", coverLetterS3Key = :key";
    values[":key"] = { S: coverLetterS3Key };
  }
  await updateIfStillCurrent(userId, applicationId, expr, names, values, "jobDescription = :expectedJD");
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------
async function processRecord(record) {
  // SQS supplies this automatically per delivery attempt - no extra IAM
  // permission needed to read it, it just rides along on the event.
  const receiveCount = parseInt(
    (record.attributes && record.attributes.ApproximateReceiveCount) || "1",
    10,
  );
  const { userId, applicationId, jobDescription } = JSON.parse(record.body);

  try {
    await setStatus(userId, applicationId, "PROCESSING");

    const profile = await ddb.send(
      new GetItemCommand({
        TableName: PROFILES_TABLE,
        Key: { userId: { S: userId } },
      }),
    );
    const resumeKey = profile.Item && profile.Item.currentResumeS3Key && profile.Item.currentResumeS3Key.S;

    if (!resumeKey) {
      await finish(userId, applicationId, jobDescription, {
        matchScore: 0,
        gapAnalysis: ["No resume uploaded yet - upload one and resubmit for a real match score."],
      });
      return;
    }

    const resumeText = await extractResumeText(UPLOADS_BUCKET, resumeKey);
    if (resumeText === null) {
      await finish(userId, applicationId, jobDescription, {
        matchScore: 0,
        gapAnalysis: ["Automatic text extraction currently supports PDF resumes only - re-upload as a PDF for a full match analysis."],
      });
      return;
    }

    const useLiveAI = await getUseLiveAI();
    let outcome;
    if (useLiveAI) {
      try {
        const apiKey = await getAiApiKey();
        outcome = await callAIProvider(resumeText, jobDescription, apiKey);
      } catch (err) {
        console.error("USE_LIVE_AI path failed, falling back to deterministic matching:", err);
        outcome = deterministicMatch(resumeText, jobDescription);
      }
    } else {
      outcome = deterministicMatch(resumeText, jobDescription);
    }

    const coverLetterS3Key = `cover-letters/${userId}/${applicationId}.txt`;
    await s3.send(
      new PutObjectCommand({
        Bucket: UPLOADS_BUCKET,
        Key: coverLetterS3Key,
        Body: outcome.coverLetterText,
        ContentType: "text/plain",
      }),
    );

    await finish(userId, applicationId, jobDescription, {
      matchScore: outcome.matchScore,
      gapAnalysis: outcome.gapAnalysis,
      coverLetterS3Key,
    });
  } catch (err) {
    console.error(`processRecord failed (attempt ${receiveCount}/${MAX_RECEIVES}):`, err);
    // Only mark FAILED once we're truly out of SQS retries - otherwise a
    // transient error on attempt 1 would show the user a permanent-looking
    // FAILED status (and stop the frontend's polling, which treats FAILED
    // as settled) moments before a routine retry succeeds.
    if (receiveCount >= MAX_RECEIVES) {
      try {
        await setStatus(userId, applicationId, "FAILED", {
          errorMessage: String((err && err.message) || err).slice(0, 500),
        });
      } catch (updateErr) {
        console.error("Also failed to record FAILED status:", updateErr);
      }
    }
    throw err; // let SQS retry, then route to the DLQ after MAX_RECEIVES
  }
}

exports.handler = async (event) => {
  // BatchSize is 1 (see the EventSourceMapping), so this loop only ever
  // runs once per invocation - but it's written to cope if that ever
  // changes.
  for (const record of event.Records) {
    await processRecord(record);
  }
};
