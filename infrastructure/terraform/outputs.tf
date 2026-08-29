output "vpc_id" {
 value = aws_vpc.nova_vpc.id
 description = "VPC ID"
}

output "public_subnet_ids" {
 value = aws_subnet.public[*].id
 description = "Public subnet IDs"
}

output "private_subnet_ids" {
 value = aws_subnet.private[*].id
 description = "Private subnet IDs"
}

output "ec2_public_ip" {
 value = aws_instance.nova_app_server.public_ip
 description = "Public IP of the application server"
}

output "ec2_private_ip" {
 value = aws_instance.nova_app_server.private_ip
 description = "Private IP of the application server"
}

output "rds_endpoint" {
 value = aws_db_instance.nova_postgres.endpoint
 description = "RDS PostgreSQL endpoint"
}

output "rds_port" {
 value = aws_db_instance.nova_postgres.port
 description = "RDS PostgreSQL port"
}

output "redis_endpoint" {
 value = aws_elasticache_cluster.nova_redis.cache_nodes[0].address
 description = "ElastiCache Redis endpoint"
}

output "redis_port" {
 value = aws_elasticache_cluster.nova_redis.cache_nodes[0].port
 description = "ElastiCache Redis port"
}

output "s3_bucket_name" {
 value = aws_s3_bucket.nova_assets.id
 description = "S3 bucket for application assets"
}

output "s3_bucket_arn" {
 value = aws_s3_bucket.nova_assets.arn
 description = "S3 bucket ARN"
}

output "load_balancer_dns" {
 value = aws_lb.nova_alb.dns_name
 description = "Application Load Balancer DNS name"
}

output "security_group_ids" {
 value = concat(
 [aws_security_group.nova_app_sg.id],
 [aws_security_group.nova_db_sg.id],
 [aws_security_group.nova_redis_sg.id],
 [aws_security_group.nova_lb_sg.id],
 )
}
