resource "random_password" "db_password" {
 length = 32
 special = false
}

resource "random_password" "redis_password" {
 length = 32
 special = false
}

resource "aws_db_subnet_group" "nova_db_subnet_group" {
 name = "${var.project_name}-db-subnet-group"
 subnet_ids = var.private_subnet_ids

 tags = {
 Name = "${var.project_name}-db-subnet-group"
 }
}

resource "aws_security_group" "nova_db_sg" {
 name = "${var.project_name}-db-sg"
 description = "Security group for RDS PostgreSQL"
 vpc_id = var.vpc_id

 ingress {
 from_port = 5432
 to_port = 5432
 protocol = "tcp"
 security_groups = [var.app_security_group_id]
 }

 tags = {
 Name = "${var.project_name}-db-sg"
 }
}

resource "aws_db_parameter_group" "nova_postgres_params" {
 name = "${var.project_name}-postgres16-params"
 family = "postgres16"

 parameter {
 name = "shared_preload_libraries"
 value = "pg_stat_statements,pgvector"
 apply_method = "pending-reboot"
 }

 parameter {
 name = "log_min_messages"
 value = "warning"
 apply_method = "immediate"
 }

 parameter {
 name = "log_min_error_statement"
 value = "error"
 apply_method = "immediate"
 }

 parameter {
 name = "log_statement"
 value = "none"
 apply_method = "immediate"
 }

 tags = {
 Name = "${var.project_name}-postgres-params"
 }
}

resource "aws_db_instance" "nova_postgres" {
 identifier = "${var.project_name}-postgres"
 engine = "postgres"
 engine_version = "16.3"
 instance_class = var.db_instance_class
 allocated_storage = var.db_allocated_storage
 storage_type = "gp3"
 storage_encrypted = true
 db_subnet_group_name = aws_db_subnet_group.nova_db_subnet_group.name
 vpc_security_group_ids = [aws_security_group.nova_db_sg.id]
 parameter_group_name = aws_db_parameter_group.nova_postgres_params.name

 username = "nova_app"
 password = random_password.db_password.result
 db_name = "nova"

 multi_az = var.multi_az
 publicly_accessible = false
 skip_final_snapshot = false
 final_snapshot_identifier = "${var.project_name}-postgres-final-snapshot"
 final_snapshot_skip = false

 backup_retention_period = 7
 backup_window = "02:00-03:00"
 maintenance_window = "sun:04:00-sun:05:00"
 auto_minor_version_upgrade = true

 deletion_protection = var.deletion_protection

 performance_insights_enabled = true
 performance_insights_retention_period = 7
 monitoring_interval = 60
 monitoring_role_arn = aws_iam_role.rds_enhanced_monitoring.arn

 tags = {
 Name = "${var.project_name}-postgres"
 }
}

resource "aws_iam_role" "rds_enhanced_monitoring" {
 name = "${var.project_name}-rds-monitoring-role"

 assume_role_policy = jsonencode({
 Version = "2012-10-17"
 Statement = [{
 Effect = "Allow"
 Principal = { Service = "monitoring.rds.amazonaws.com" }
 Action = "sts:AssumeRole"
 }]
 })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
 role = aws_iam_role.rds_enhanced_monitoring.name
 policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_elasticache_subnet_group" "nova_redis_subnet_group" {
 name = "${var.project_name}-redis-subnet-group"
 subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "nova_redis_sg" {
 name = "${var.project_name}-redis-sg"
 description = "Security group for ElastiCache Redis"
 vpc_id = var.vpc_id

 ingress {
 from_port = 6379
 to_port = 6379
 protocol = "tcp"
 security_groups = [var.app_security_group_id]
 }

 tags = {
 Name = "${var.project_name}-redis-sg"
 }
}

resource "aws_elasticache_cluster" "nova_redis" {
 cluster_id = "${var.project_name}-redis"
 engine = "redis"
 engine_version = "7.1"
 node_type = var.redis_node_type
 num_cache_nodes = 1
 port = 6379

 subnet_group_name = aws_elasticache_subnet_group.nova_redis_subnet_group.name
 security_group_ids = [aws_security_group.nova_redis_sg.id]

 at_rest_encryption_enabled = true
 transit_encryption_enabled = true
 auth_token = random_password.redis_password.result

 automatic_failover_enabled = false # Cluster mode disabled
 engine_cache_config_version = "1.6.5"

 snapshot_retention_limit = 7
 snapshot_window = "03:00-05:00"
 maintenance_window = "sun:05:00-sun:06:00"

 log_delivery_configuration {
 destination_type = "cloudwatch"
 log_format = "text"
 log_type = "slow-log"
 }
}
