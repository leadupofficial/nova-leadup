variable "project_name" {
 type = string
}

variable "vpc_id" {
 type = string
}

variable "private_subnet_ids" {
 type = list(string)
}

variable "app_security_group_id" {
 type = string
}

variable "db_instance_class" {
 type = string
 default = "db.t3.small"
}

variable "db_allocated_storage" {
 type = number
 default = 50
}

variable "redis_node_type" {
 type = string
 default = "cache.t3.micro"
}

variable "multi_az" {
 type = bool
 default = false
}

variable "deletion_protection" {
 type = bool
 default = true
}
