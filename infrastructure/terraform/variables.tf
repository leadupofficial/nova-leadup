variable "aws_region" {
 type = string
 description = "AWS region for all resources"
 default = "us-east-1"
}

variable "project_name" {
 type = string
 default = "nova-leadup"
}

variable "domain_name" {
 type = string
 description = "Primary domain name"
 default = "nova.leadup.in"
}

variable "instance_type" {
 type = string
 description = "EC2 instance type for application server"
 default = "t3.large"
}

variable "db_instance_class" {
 type = string
 description = "RDS instance class"
 default = "db.t3.small"
}

variable "db_allocated_storage" {
 type = number
 description = "RDS allocated storage in GB"
 default = 50
}

variable "redis_node_type" {
 type = string
 description = "ElastiCache node type"
 default = "cache.t3.micro"
}

variable "key_pair_name" {
 type = string
 description = "Existing EC2 key pair name for SSH access"
 default = ""
}

variable "ssl_certificate_arn" {
 type = string
 description = "ACM certificate ARN for the domain"
 default = ""
}

variable "allowed_ssh_cidr" {
 type = string
 description = "CIDR block allowed for SSH"
 default = "0.0.0.0/0"
}
