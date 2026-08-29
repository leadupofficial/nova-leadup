# NOVA Production Infrastructure — Terraform Module

## Module: Storage

This module provisions S3-compatible object storage and associated IAM policies.

### Resources

- S3 bucket for application assets (audio files, images, exports)
- S3 bucket lifecycle policy (transition to Infrequent Access after 30 days, Glacier after 90 days)
- S3 bucket versioning (for accidental deletion recovery)
- S3 bucket encryption (AES-256 server-side)
- S3 bucket CORS configuration (for browser uploads)
- S3 bucket public access block (all public access blocked)
- IAM policy for application access

### Design Decisions

- S3 used instead of self-hosted MinIO for production
- Versioning enabled for data integrity
- Lifecycle rules for cost optimization
- No public access — all access via presigned URLs or authenticated API
- Server-side encryption with S3-managed keys (configurable to KMS)

### Bucket Structure

```
s3://nova-leadup-assets/
├── audio/ — Voice message recordings
├── avatars/ — User profile images
├── exports/ — Data exports (CSV, JSON)
├── temp/ — Temporary processing files (auto-deleted)
```

### Cost Estimate

- S3 Standard: ~$0.023/GB/month for first 50 TB
- S3 Infrequent Access: ~$0.0125/GB/month
- Expected monthly: $1-10/month depending on usage
