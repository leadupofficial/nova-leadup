variable "project_name" {
 type = string
}

variable "vpc_id" {
 type = string
}

variable "public_subnet_ids" {
 type = list(string)
}

variable "app_instance_id" {
 type = string
}

variable "ssl_certificate_arn" {
 type = string
 default = ""
}

variable "s3_access_logs_bucket" {
 type = string
}
