resource "aws_s3_bucket" "nova_assets" {
 bucket = "${var.project_name}-assets-${var.environment}"

 tags = {
 Name = "${var.project_name}-assets"
 Environment = var.environment
 }
}

resource "aws_s3_bucket_versioning" "nova_assets_versioning" {
 bucket = aws_s3_bucket.nova_assets.id

 versioning_configuration {
 status = "Enabled"
 }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "nova_assets_encryption" {
 bucket = aws_s3_bucket.nova_assets.id

 rule {
 apply_server_side_encryption_by_default {
 sse_algorithm = "AES256"
 }
 }
}

resource "aws_s3_bucket_lifecycle_configuration" "nova_assets_lifecycle" {
 bucket = aws_s3_bucket.nova_assets.id

 rule {
 id = "nova-assets-lifecycle"
 status = "Enabled"

 transition {
 days = 30
 storage_class = "STANDARD_IA"
 }

 transition {
 days = 90
 storage_class = "GLACIER_IR"
 }

 expiration {
 days = 365
 expired_object_delete_marker = true
 }

 noncurrent_version_expiration {
 noncurrent_days = 30
 }
 }
}

resource "aws_s3_bucket_public_access_block" "nova_assets_block" {
 bucket = aws_s3_bucket.nova_assets.id

 block_public_acls = true
 block_public_policy = true
 ignore_public_acls = true
 restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "nova_assets_cors" {
 bucket = aws_s3_bucket.nova_assets.id

 cors_rule {
 allowed_origins = ["https://${var.domain_name}", "https://admin.${var.domain_name}"]
 allowed_methods = ["GET", "PUT", "POST", "DELETE"]
 allowed_headers = ["*"]
 expose_headers = ["ETag"]
 max_age_seconds = 3600
 }
}

resource "aws_s3_bucket" "nova_terraform_state" {
 bucket = "${var.project_name}-terraform-state-${var.environment}"

 tags = {
 Name = "${var.project_name}-terraform-state"
 Environment = var.environment
 }
}

resource "aws_s3_bucket_versioning" "nova_terraform_state_versioning" {
 bucket = aws_s3_bucket.nova_terraform_state.id

 versioning_configuration {
 status = "Enabled"
 }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "nova_terraform_state_encryption" {
 bucket = aws_s3_bucket.nova_terraform_state.id

 rule {
 apply_server_side_encryption_by_default {
 sse_algorithm = "AES256"
 }
 }
}

resource "aws_s3_bucket_public_access_block" "nova_terraform_state_block" {
 bucket = aws_s3_bucket.nova_terraform_state.id

 block_public_acls = true
 block_public_policy = true
 ignore_public_acls = true
 restrict_public_buckets = true
}

resource "aws_dynamodb_table" "terraform_locks" {
 name = "${var.project_name}-terraform-locks-${var.environment}"
 billing_mode = "PAY_PER_REQUEST"
 hash_key = "LockID"

 attribute {
 name = "LockID"
 type = "S"
 }

 tags = {
 Name = "${var.project_name}-terraform-locks"
 Environment = var.environment
 }
}
