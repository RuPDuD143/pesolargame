// functions/lib/respawn-tasks.js
//
// Why Cloud Tasks: the old in-memory version used setTimeout() to respawn
// a node 5s after depletion. Cloud Functions instances aren't guaranteed
// to stay alive that long (they can scale to zero between requests), so a
// bare setTimeout would silently drop respawns under real traffic. Cloud
// Tasks schedules a real HTTP call for "5 seconds from now" that runs
// reliably even if this instance has since shut down.
//
// No manual config needed for project/region: Firebase Functions
// automatically sets process.env.GCLOUD_PROJECT at runtime, and every
// function in this file deploys to the default region (us-central1,
// since nothing here calls setGlobalOptions to change it) - so the
// respawn task URL can be built deterministically instead of asking you
// to paste it in after a first deploy.
//
// The ONE thing that can't be automated: you must create the Cloud Tasks
// queue once (Google Cloud Console -> Cloud Tasks -> Create Queue, name
// "pesolar-respawns", region "us-central1" - see the README for the
// exact click path). Cloud Tasks has no default queue; it has to exist
// before the first mining strike happens.

const { CloudTasksClient } = require('@google-cloud/tasks');
const tasksClient = new CloudTasksClient();

const QUEUE_NAME = 'pesolar-respawns';
const REGION = process.env.TASKS_LOCATION || 'us-central1';

function respawnTaskUrl(project) {
  return process.env.RESPAWN_TASK_URL || `https://${REGION}-${project}.cloudfunctions.net/respawnNodeTask`;
}

async function scheduleRespawn({ locationId, nodeId, delayMs = 5000 }) {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;

  if (!project) {
    console.error('scheduleRespawn: no project id found in environment - node will stay depleted until manually respawned');
    return;
  }

  const parent = tasksClient.queuePath(project, REGION, QUEUE_NAME);
  const scheduleTime = { seconds: Math.floor((Date.now() + delayMs) / 1000) };

  try {
    await tasksClient.createTask({
      parent,
      task: {
        scheduleTime,
        httpRequest: {
          httpMethod: 'POST',
          url: respawnTaskUrl(project),
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ locationId, nodeId })).toString('base64')
        }
      }
    });
  } catch (err) {
    // Most likely cause: the "pesolar-respawns" queue doesn't exist yet.
    console.error('scheduleRespawn failed (has the Cloud Tasks queue been created?):', err.message);
  }
}

module.exports = { scheduleRespawn };

