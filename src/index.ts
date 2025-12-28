import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';

interface AttestationPayload {
  event_type: string;
  data: Record<string, unknown>;
  document_hash?: string;
}

interface AttestationResponse {
  certificate_id: string;
  document_hash: string;
  ipfs_hash: string;
  verification_url: string;
  status: string;
  tx_hash?: string;
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve('0x' + hash.digest('hex')));
    stream.on('error', reject);
  });
}

function hashString(data: string): string {
  return '0x' + crypto.createHash('sha256').update(data).digest('hex');
}

async function createAttestation(
  apiUrl: string,
  apiKey: string,
  payload: AttestationPayload
): Promise<AttestationResponse> {
  // Use /events/ingest for the Rust ingestion API
  const endpoint = apiUrl.includes('ingest.') ? '/events/ingest' : '/events';
  const response = await fetch(`${apiUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API request failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<AttestationResponse>;
}

async function waitForConfirmation(
  apiUrl: string,
  apiKey: string,
  certificateId: string,
  maxWaitMs: number = 120000
): Promise<AttestationResponse> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    const response = await fetch(`${apiUrl}/events/${certificateId}`, {
      headers: { 'X-API-Key': apiKey },
    });
    
    if (response.ok) {
      const data = await response.json() as AttestationResponse;
      if (data.status === 'confirmed' && data.tx_hash) {
        return data;
      }
    }
    
    // Wait 5 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  throw new Error('Timeout waiting for blockchain confirmation');
}

async function attestCommit(): Promise<AttestationPayload> {
  const context = github.context;
  const includeDiff = core.getInput('include-diff') === 'true';
  
  const commitData: Record<string, unknown> = {
    // Repository info
    repository: context.repo.repo,
    owner: context.repo.owner,
    full_name: `${context.repo.owner}/${context.repo.repo}`,
    
    // Commit info
    commit_sha: context.sha,
    commit_message: context.payload.head_commit?.message || context.payload.commits?.[0]?.message || '',
    commit_author: context.payload.head_commit?.author?.name || context.actor,
    commit_email: context.payload.head_commit?.author?.email || '',
    commit_timestamp: context.payload.head_commit?.timestamp || new Date().toISOString(),
    
    // Branch info
    ref: context.ref,
    branch: context.ref.replace('refs/heads/', ''),
    
    // Workflow info
    workflow: context.workflow,
    run_id: context.runId,
    run_number: context.runNumber,
    
    // GitHub URLs
    commit_url: `https://github.com/${context.repo.owner}/${context.repo.repo}/commit/${context.sha}`,
    workflow_url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  };

  // Include diff hash if requested
  if (includeDiff && context.payload.head_commit?.id) {
    // Create a deterministic hash of the commit changes
    const diffData = JSON.stringify({
      added: context.payload.head_commit.added || [],
      removed: context.payload.head_commit.removed || [],
      modified: context.payload.head_commit.modified || [],
    });
    commitData.diff_hash = hashString(diffData);
  }

  // Create document hash from commit data
  const documentHash = hashString(JSON.stringify({
    sha: context.sha,
    repo: `${context.repo.owner}/${context.repo.repo}`,
    timestamp: commitData.commit_timestamp,
  }));

  return {
    event_type: 'github_commit',
    data: commitData,
    document_hash: documentHash,
  };
}

async function attestRelease(): Promise<AttestationPayload> {
  const context = github.context;
  const release = context.payload.release;
  
  if (!release) {
    throw new Error('No release data found. This action should be triggered on release events.');
  }

  const releaseData: Record<string, unknown> = {
    // Repository info
    repository: context.repo.repo,
    owner: context.repo.owner,
    full_name: `${context.repo.owner}/${context.repo.repo}`,
    
    // Release info
    release_id: release.id,
    release_name: release.name || release.tag_name,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    draft: release.draft,
    prerelease: release.prerelease,
    created_at: release.created_at,
    published_at: release.published_at,
    
    // Author
    author: release.author?.login || context.actor,
    
    // Content
    body: release.body || '',
    
    // URLs
    html_url: release.html_url,
    tarball_url: release.tarball_url,
    zipball_url: release.zipball_url,
    
    // Assets count
    assets_count: release.assets?.length || 0,
  };

  // Create document hash from release data
  const documentHash = hashString(JSON.stringify({
    tag: release.tag_name,
    repo: `${context.repo.owner}/${context.repo.repo}`,
    created_at: release.created_at,
  }));

  return {
    event_type: 'github_release',
    data: releaseData,
    document_hash: documentHash,
  };
}

async function attestArtifact(): Promise<AttestationPayload> {
  const context = github.context;
  const artifactPath = core.getInput('artifact-path');
  
  if (!artifactPath) {
    throw new Error('artifact-path is required for artifact attestation');
  }

  const globber = await glob.create(artifactPath);
  const files = await globber.glob();
  
  if (files.length === 0) {
    throw new Error(`No files found matching pattern: ${artifactPath}`);
  }

  core.info(`Found ${files.length} file(s) to attest`);

  const artifacts: Array<{
    name: string;
    path: string;
    size: number;
    hash: string;
  }> = [];

  for (const file of files) {
    const stats = fs.statSync(file);
    const hash = await hashFile(file);
    
    artifacts.push({
      name: path.basename(file),
      path: file,
      size: stats.size,
      hash: hash,
    });
    
    core.info(`  - ${path.basename(file)}: ${hash}`);
  }

  // Create combined hash of all artifacts
  const combinedHash = hashString(
    artifacts.map(a => a.hash).sort().join('')
  );

  const artifactData: Record<string, unknown> = {
    // Repository info
    repository: context.repo.repo,
    owner: context.repo.owner,
    full_name: `${context.repo.owner}/${context.repo.repo}`,
    
    // Commit info
    commit_sha: context.sha,
    ref: context.ref,
    
    // Workflow info
    workflow: context.workflow,
    run_id: context.runId,
    run_number: context.runNumber,
    
    // Artifacts
    artifacts: artifacts.map(a => ({
      name: a.name,
      size: a.size,
      hash: a.hash,
    })),
    artifact_count: artifacts.length,
    combined_hash: combinedHash,
    
    // URLs
    workflow_url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  };

  return {
    event_type: 'github_artifact',
    data: artifactData,
    document_hash: combinedHash,
  };
}

async function attestCustom(): Promise<AttestationPayload> {
  const context = github.context;
  const eventType = core.getInput('event-type');
  const customDataStr = core.getInput('custom-data');
  
  let customData: Record<string, unknown> = {};
  try {
    customData = JSON.parse(customDataStr);
  } catch {
    core.warning('Failed to parse custom-data as JSON, using empty object');
  }

  const data: Record<string, unknown> = {
    // Repository info
    repository: context.repo.repo,
    owner: context.repo.owner,
    full_name: `${context.repo.owner}/${context.repo.repo}`,
    
    // Context
    commit_sha: context.sha,
    ref: context.ref,
    workflow: context.workflow,
    run_id: context.runId,
    actor: context.actor,
    event_name: context.eventName,
    
    // Custom data
    ...customData,
  };

  const documentHash = hashString(JSON.stringify({
    repo: `${context.repo.owner}/${context.repo.repo}`,
    sha: context.sha,
    run_id: context.runId,
    custom: customData,
  }));

  return {
    event_type: eventType,
    data: data,
    document_hash: documentHash,
  };
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput('api-key', { required: true });
    const apiUrl = core.getInput('api-url');
    const attestationType = core.getInput('type');
    const waitForConfirmationFlag = core.getInput('wait-for-confirmation') === 'true';

    core.info(`🔗 ProofChain Attestation Action`);
    core.info(`   Type: ${attestationType}`);
    core.info(`   API URL: ${apiUrl}`);

    // Build attestation payload based on type
    let payload: AttestationPayload;
    
    switch (attestationType) {
      case 'commit':
        core.info('📝 Attesting commit...');
        payload = await attestCommit();
        break;
      case 'release':
        core.info('🏷️ Attesting release...');
        payload = await attestRelease();
        break;
      case 'artifact':
        core.info('📦 Attesting artifact(s)...');
        payload = await attestArtifact();
        break;
      case 'custom':
        core.info('⚙️ Creating custom attestation...');
        payload = await attestCustom();
        break;
      default:
        throw new Error(`Unknown attestation type: ${attestationType}`);
    }

    core.info(`   Document Hash: ${payload.document_hash}`);

    // Create the attestation
    core.info('🚀 Submitting attestation to ProofChain...');
    let result = await createAttestation(apiUrl, apiKey, payload);

    core.info(`✅ Attestation created!`);
    core.info(`   Certificate ID: ${result.certificate_id}`);
    core.info(`   IPFS Hash: ${result.ipfs_hash}`);

    // Wait for blockchain confirmation if requested
    if (waitForConfirmationFlag) {
      core.info('⏳ Waiting for blockchain confirmation...');
      result = await waitForConfirmation(apiUrl, apiKey, result.certificate_id);
      core.info(`🔗 Blockchain TX: ${result.tx_hash}`);
    }

    // Set outputs
    core.setOutput('certificate-id', result.certificate_id);
    core.setOutput('document-hash', payload.document_hash);
    core.setOutput('verification-url', result.verification_url);
    core.setOutput('ipfs-hash', result.ipfs_hash);
    if (result.tx_hash) {
      core.setOutput('tx-hash', result.tx_hash);
    }

    // Create summary
    core.summary
      .addHeading('🔗 ProofChain Attestation')
      .addTable([
        [{ data: 'Property', header: true }, { data: 'Value', header: true }],
        ['Type', attestationType],
        ['Certificate ID', result.certificate_id],
        ['Document Hash', payload.document_hash || 'N/A'],
        ['IPFS Hash', result.ipfs_hash],
        ['Status', result.status],
        ...(result.tx_hash ? [['TX Hash', result.tx_hash]] : []),
      ])
      .addLink('🔍 Verify Attestation', result.verification_url)
      .write();

    core.info(`\n🎉 Attestation complete!`);
    core.info(`   Verify at: ${result.verification_url}`);

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  }
}

run();
