# NOVA Production Infrastructure — Root Configuration
# This file calls all modules to provision the complete production stack.
#
# Dependency order:
# storage → networking → compute → database → loadbalancer

# =============================================
# STORAGE (S3 + Terraform state backend)
# =============================================
module "storage" {
 source = "./modules/storage"

 project_name = var.project_name
 domain_name = var.domain_name
 environment = "production"
}

# =============================================
# NETWORKING (VPC, Subnets, NAT, IGW)
# =============================================
module "networking" {
 source = "./modules/networking"

 project_name = var.project_name
 vpc_cidr = var.vpc_cidr
}

# =============================================
# COMPUTE (EC2, Security Groups, IAM)
# Security groups created here are referenced by database and loadbalancer modules
# =============================================
module "compute" {
 source = "./modules/compute"

 project_name = var.project_name
 vpc_id = module.networking.vpc_id
 public_subnet_id = module.networking.public_subnet_ids[0]
 instance_type = var.instance_type
 key_pair_name = var.key_pair_name
 allowed_ssh_cidr = var.allowed_ssh_cidr
 s3_bucket_arn = module.storage.assets_bucket_arn
 domain_name = var.domain_name
}

# =============================================
# DATABASE (RDS PostgreSQL + ElastiCache Redis)
# Requires compute security group for access control
# =============================================
module "database" {
 source = "./modules/database"

 project_name = var.project_name
 vpc_id = module.networking.vpc_id
 private_subnet_ids = module.networking.private_subnet_ids
 app_security_group_id = module.compute.app_security_group_id
 db_instance_class = var.db_instance_class
 db_allocated_storage = var.db_allocated_storage
 redis_node_type = var.redis_node_type
 multi_az = var.multi_az
 deletion_protection = true
}

# =============================================
# LOAD BALANCER (ALB with HTTPS termination)
# =============================================
module "loadbalancer" {
 source = "./modules/loadbalancer"

 project_name = var.project_name
 vpc_id = module.networking.vpc_id
 public_subnet_ids = module.networking.public_subnet_ids
 app_instance_id = module.compute.instance_id
 ssl_certificate_arn = var.ssl_certificate_arn
 s3_access_logs_bucket = module.storage.assets_bucket_name
}
