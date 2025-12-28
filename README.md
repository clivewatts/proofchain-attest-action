# ProofChain GitHub Action

Attest your commits, releases, and build artifacts to the blockchain using ProofChain. Create tamper-proof records of your software supply chain.

## Features

- 📝 **Commit Attestation** - Record every commit with author, message, and diff hash
- 🏷️ **Release Attestation** - Attest releases with tag, notes, and asset info
- 📦 **Artifact Attestation** - Hash and attest build artifacts (binaries, containers, etc.)
- ⚙️ **Custom Attestation** - Create custom attestations with your own data
- 🔗 **Blockchain Proof** - All attestations are anchored on Base blockchain
- ✅ **Public Verification** - Anyone can verify using the certificate ID

## Quick Start

### Attest Commits

```yaml
name: Attest Commits
on: [push]

jobs:
  attest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Attest Commit
        uses: proofchain/attest-action@v1
        with:
          api-key: ${{ secrets.PROOFCHAIN_API_KEY }}
          type: commit
```

### Attest Releases

```yaml
name: Attest Releases
on:
  release:
    types: [published]

jobs:
  attest:
    runs-on: ubuntu-latest
    steps:
      - name: Attest Release
        uses: proofchain/attest-action@v1
        with:
          api-key: ${{ secrets.PROOFCHAIN_API_KEY }}
          type: release
```

### Attest Build Artifacts

```yaml
name: Build and Attest
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Build
        run: |
          npm ci
          npm run build
          
      - name: Attest Artifacts
        uses: proofchain/attest-action@v1
        with:
          api-key: ${{ secrets.PROOFCHAIN_API_KEY }}
          type: artifact
          artifact-path: |
            dist/**/*.js
            dist/**/*.css
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api-key` | Your ProofChain API key | Yes | - |
| `api-url` | ProofChain API URL | No | `https://ingest.proofchain.co.za` |
| `type` | Attestation type: `commit`, `release`, `artifact`, `custom` | No | `commit` |
| `artifact-path` | Path to artifacts (glob patterns supported) | For `artifact` type | - |
| `event-type` | Custom event type name | For `custom` type | `github_attestation` |
| `custom-data` | Additional JSON data | No | `{}` |
| `include-diff` | Include commit diff hash | No | `false` |
| `wait-for-confirmation` | Wait for blockchain confirmation | No | `false` |

## Outputs

| Output | Description |
|--------|-------------|
| `certificate-id` | The certificate ID for verification |
| `document-hash` | The document hash that was attested |
| `verification-url` | URL to verify the attestation |
| `ipfs-hash` | IPFS hash of the attestation data |
| `tx-hash` | Blockchain transaction hash (if `wait-for-confirmation` is true) |

## Examples

### Full CI/CD Pipeline

```yaml
name: CI/CD with Attestation
on:
  push:
    branches: [main]
  release:
    types: [published]

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      artifact-hash: ${{ steps.attest.outputs.document-hash }}
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install & Build
        run: |
          npm ci
          npm run build
          
      - name: Attest Build
        id: attest
        uses: proofchain/attest-action@v1
        with:
          api-key: ${{ secrets.PROOFCHAIN_API_KEY }}
          type: artifact
          artifact-path: dist/**/*
          wait-for-confirmation: true
          
      - name: Upload Artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build
          path: dist/
          
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Download Artifacts
        uses: actions/download-artifact@v4
        with:
          name: build
          
      - name: Deploy
        run: echo "Deploying verified build..."
        
      - name: Add Verification Badge
        run: |
          echo "Build verified: https://verify.proofchain.io/your-tenant/${{ needs.build.outputs.artifact-hash }}"
```

### Custom Attestation

```yaml
- name: Custom Attestation
  uses: proofchain/attest-action@v1
  with:
    api-key: ${{ secrets.PROOFCHAIN_API_KEY }}
    type: custom
    event-type: security_scan
    custom-data: |
      {
        "scanner": "trivy",
        "vulnerabilities_found": 0,
        "scan_timestamp": "${{ github.event.head_commit.timestamp }}",
        "image": "myapp:${{ github.sha }}"
      }
```

### Docker Image Attestation

```yaml
- name: Build Docker Image
  run: |
    docker build -t myapp:${{ github.sha }} .
    docker save myapp:${{ github.sha }} > image.tar
    
- name: Attest Docker Image
  uses: proofchain/attest-action@v1
  with:
    api-key: ${{ secrets.PROOFCHAIN_API_KEY }}
    type: artifact
    artifact-path: image.tar
```

## Verification

Anyone can verify your attestations:

### Via Web
Visit `https://verify.proofchain.co.za/c/{certificate-id}`

### Via API
```bash
curl https://api.proofchain.co.za/verify/cert/{certificate-id}
```

### Via CLI
```bash
proofchain verify {certificate-id}
```

## Security

- Store your API key as a GitHub secret (`PROOFCHAIN_API_KEY`)
- Never commit API keys to your repository
- Use environment-specific API keys for different workflows

## Getting Your API Key

1. Sign up at [proofchain.co.za](https://proofchain.co.za)
2. Go to Settings → API Keys
3. Create a new API key
4. Add it as a secret in your GitHub repository

## Support

- 📚 [Documentation](https://proofchain.co.za/docs)
- 🐛 [Issues](https://github.com/clivewatts/attestify/issues)

## License

MIT
