output "assets_bucket_name" {
 value = aws_s3_bucket.nova_assets.id
}

output "assets_bucket_arn" {
 value = aws_s3_bucket.nova_assets.arn
}

output "terraform_state_bucket" {
 value = aws_s3_bucket.nova_terraform_state.id
}

output "dynamodb_lock_table" {
 value = aws_dynamodb_table.terraform_locks.name
}
