# CRM Google Inbox Starter — Complete AWS Deployment

This package deploys a React frontend to **private S3 + CloudFront**, and a Node.js Lambda API through API Gateway. SAM/CloudFormation creates the AWS infrastructure. The included PowerShell script builds and uploads the React frontend.

## Package contents

| File | Purpose | Replace/edit? |
|---|---|---|
| `template.yaml` | Complete AWS SAM infrastructure: private S3, CloudFront + OAC, API Gateway, Lambda, DynamoDB, KMS, IAM | **Use this complete replacement** if you have the older template |
| `backend/src/index.js` | OAuth callback, Gmail inbox API, session, KMS token encryption | No changes required for this deployment |
| `backend/package.json` | Backend dependencies | No changes required |
| `backend/.env.example` | Local/backend environment reference | Only for local development |
| `frontend/src/App.jsx` | React UI; calls same-origin `/api/*` CloudFront route | **Use this complete replacement** if you have the older App.jsx |
| `frontend/.env.example` | Frontend environment reference | **Replace**; same-origin API means no API URL is needed |
| `deploy-frontend.ps1` | Windows PowerShell frontend build/upload/cache invalidation script | Run it; edit nothing unless you prefer another deployment method |
| `samconfig.toml` | SAM deployment defaults | Optional; keep or edit stack name/region |

> This is a starter/training app, not a production security review. Test with a non-sensitive Google account first.

---

# Part 1 — Google Cloud Console setup

## 1. Create Google Cloud project and enable Gmail API

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select your existing project).
3. Go to **APIs & Services → Library**.
4. Search for **Gmail API** and click **Enable**.

## 2. Configure OAuth consent screen

1. Go to **Google Auth Platform** (or **APIs & Services → OAuth consent screen**, depending on Console UI).
2. Configure app name, user support email, developer contact email.
3. For a personal/testing project, choose **External** and keep the app in **Testing**.
4. Add your own Google account as a **Test user**.
5. Add scopes:
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/gmail.readonly`

The Gmail `gmail.readonly` scope is restricted and grants mailbox read access. This app displays messages with the `INBOX` label, but Google does **not** provide an OAuth scope that limits access only to Inbox. Public apps may require Google verification and potentially a security assessment. Do not use real customer data until you have reviewed Google's requirements.

## 3. Create OAuth client

1. Go to **Google Auth Platform → Clients** or **APIs & Services → Credentials**.
2. Click **Create OAuth client**.
3. Application type: **Web application**.
4. Name it, for example `CRM Google Inbox Web`.
5. You will add the Authorized redirect URI after the first AWS deployment.
6. Copy the **Client ID** and **Client Secret** and keep them private. Never put the client secret in React/frontend code or commit it to Git.

---

# Part 2 — Install tools on Windows

Install:

- Node.js 20 or newer: [Node.js](https://nodejs.org/)
- AWS CLI: [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- AWS SAM CLI: [SAM CLI install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Git (optional)

Open **PowerShell** in the project folder and check:

```powershell
node --version
npm --version
aws --version
sam --version
```

Configure AWS CLI credentials for the AWS account you want to deploy into:

```powershell
aws configure
```

Use an IAM identity with permissions to create SAM/CloudFormation stacks, Lambda, API Gateway, DynamoDB, KMS, S3, and CloudFront resources. For production, use an appropriately restricted deployment role rather than permanent administrator credentials.

Choose your AWS region. Example below uses `ap-south-1` (Mumbai); you may use another region that supports the required services.

```powershell
aws configure set region ap-south-1
```

---

# Part 3 — Deploy the AWS stack (first deployment)

## 1. Open the project root

The root folder is the folder containing `template.yaml`, `backend`, `frontend`, and `deploy-frontend.ps1`.

```powershell
cd path\to\crm-google-inbox-starter
```

Install backend dependencies and build SAM:

```powershell
cd backend
npm install
cd ..
sam build
```

## 2. Deploy the infrastructure

```powershell
sam deploy --guided
```

Suggested answers:

- Stack Name: `crm-google-inbox-jayanka`
- AWS Region: `ap-south-1` (or your selected region)
- Confirm changes before deploy: `Y`
- Allow SAM CLI IAM role creation: `Y`
- Disable rollback: `N`
- Save arguments to configuration file: `Y`

For parameter prompts, enter:

- `GoogleClientId`: your Google OAuth Client ID
- `GoogleClientSecret`: your Google OAuth Client Secret
- `GoogleCallbackUrl`: keep the default placeholder for the first deployment
- `FrontendUrl`: keep the default placeholder for the first deployment

**Secret handling:** SAM guided deployment can place parameters in local configuration. Do not commit `samconfig.toml` if it contains your Google client secret. The template's secret parameter is `NoEcho`, but CLI history and local files still need protection. For production, use AWS Secrets Manager and a reviewed secret-injection workflow.

The first deployment creates the AWS resources and prints outputs. Save these output values:

- `FrontendUrl`
- `FrontendBucketName`
- `CloudFrontDistributionId`
- `ApiUrl`
- `GoogleCallbackUrl`

CloudFront may take several minutes to become deployed.

## 3. Add Google OAuth callback URL

Copy the **GoogleCallbackUrl** output exactly. It should look like:

`https://API_ID.execute-api.ap-south-1.amazonaws.com/prod/api/oauth/google/callback`

In Google Cloud Console:

1. Go to **Google Auth Platform → Clients** (or Credentials).
2. Open the OAuth Web Client created earlier.
3. Under **Authorized redirect URIs**, add the exact callback URL.
4. Save.

Do not add a trailing slash unless it is included in the output.

## 4. Redeploy with the actual callback and frontend URL

Use the actual `FrontendUrl` and `GoogleCallbackUrl` outputs from the first deployment:

```powershell
sam deploy --parameter-overrides `
  GoogleClientId="YOUR_GOOGLE_CLIENT_ID" `
  GoogleClientSecret="YOUR_GOOGLE_CLIENT_SECRET" `
  GoogleCallbackUrl="https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com/prod/api/oauth/google/callback" `
  FrontendUrl="https://YOUR_CLOUDFRONT_DOMAIN.cloudfront.net"
```

Replace every `YOUR_...` value with your real value. Use the same values/stack name/region from the first deployment. This is a complete command; do not paste placeholder values as-is.

**Important:** Avoid putting the client secret in shell history or a committed file. For a shared or production account, use Secrets Manager or a secure CI/CD secret mechanism.

---

# Part 4 — Build and publish the frontend

The SAM template creates the private S3 bucket and CloudFront distribution. It does not automatically upload the React build because the build artifact must be generated first. The included script automates build, S3 upload, and CloudFront invalidation.

From the project root:

```powershell
.\deploy-frontend.ps1 -BucketName "YOUR_FRONTEND_BUCKET_NAME" -DistributionId "YOUR_CLOUDFRONT_DISTRIBUTION_ID"
```

Use the exact `FrontendBucketName` and `CloudFrontDistributionId` outputs from SAM. The script:

1. Runs `npm install` in `frontend`.
2. Runs `npm run build`.
3. Uploads `frontend/dist` to the private S3 bucket.
4. Creates a CloudFront invalidation for `/*`.

Wait until CloudFront finishes deploying/invalidation, then open the `FrontendUrl` output in a browser.

If you prefer manual upload instead of the script:

```powershell
cd frontend
npm install
npm run build
cd ..
aws s3 sync .\frontend\dist s3://YOUR_FRONTEND_BUCKET_NAME/ --delete
aws cloudfront create-invalidation --distribution-id YOUR_CLOUDFRONT_DISTRIBUTION_ID --paths '/*'
```

---

# Part 5 — Test the complete application

1. Open the `FrontendUrl` CloudFront output.
2. Click **Continue with Google**.
3. Choose the Google test user you added to the OAuth consent screen.
4. Review and approve profile + Gmail read-only access.
5. Google redirects to the API Gateway callback.
6. Lambda validates OAuth state and Google identity.
7. The refresh token is encrypted using AWS KMS and stored in DynamoDB.
8. The app creates an HttpOnly session cookie and redirects back to CloudFront `/inbox`.
9. The frontend calls CloudFront `/api/inbox`; CloudFront forwards `/api/*` to API Gateway.
10. Lambda decrypts the refresh token, calls Gmail API, and returns up to 20 messages labeled `INBOX`.
11. Click **Refresh** to reload; click **Sign out** to delete the session.

## Architecture

```text
Browser
  │
  ▼
CloudFront distribution
  ├── /*       → private S3 bucket (React SPA; CloudFront OAC)
  └── /api/*   → API Gateway (prod stage)
                    │
                    ▼
                 Lambda
                    ├── Google OAuth / Gmail API
                    ├── DynamoDB (OAuth state, sessions, encrypted refresh token)
                    └── AWS KMS (encrypt/decrypt refresh token)
```

## Inbox / spam clarification

The app only displays Gmail messages carrying the `INBOX` label. It does not force mail into Inbox, override spam classification, or bypass Gmail filtering. For legitimate sender delivery, configure SPF, DKIM, and DMARC and follow Google's sender guidelines. No setup guarantees Inbox placement.

## What this starter does not include

- Sending email (`gmail.send` scope is intentionally not requested)
- CRM contacts, deals, or other CRM data models
- Admin control over Gmail spam classification
- Production-grade rate limiting, audit trails, alerting, or comprehensive security review
- Google OAuth verification/security assessment work

## Troubleshooting

### Google `redirect_uri_mismatch`
The redirect URI in Google Cloud must exactly match the SAM `GoogleCallbackUrl` output, including `/prod/api/oauth/google/callback`.

### Login succeeds but inbox returns 401
Make sure the app was deployed again with the real `FrontendUrl` and `GoogleCallbackUrl`. Check Lambda logs in CloudWatch. The user may need to sign out and reconnect Google.

### CloudFront shows AccessDenied or an old page
Wait for the distribution to finish deploying, rerun `deploy-frontend.ps1`, and verify the S3 bucket is private with the CloudFront OAC bucket policy created by the stack.

### API calls return 403/404
Confirm the CloudFront behavior is `/api/*`, API Gateway stage is `prod`, and backend API routes start with `/api/`. Do not change one side without changing the other.

### Google consent says app is unverified
This is expected for many apps in Testing. Add the Google account as a test user. Do not ask users to bypass Google's warning for a public app; complete required verification before public launch.

---

# File replacement instructions

If you are updating the older starter ZIP I gave you, replace these files with the files from this package:

1. **Project root `template.yaml`** → replace the entire file with this package's `template.yaml`.
2. **`frontend/src/App.jsx`** → replace the entire file with this package's `frontend/src/App.jsx`.
3. **`frontend/.env.example`** → replace the entire file with this package's `frontend/.env.example`.
4. Copy **`deploy-frontend.ps1`** into the project root (same folder as `template.yaml`).
5. Replace **`README.md`** with this package's `README.md`.

Do not replace `backend/src/index.js` for this CloudFront routing update. Its route matching uses the path suffix and works with `/api/...` routes. Keep your Google Client Secret private.
