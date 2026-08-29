variable "project_name" {
 type = string
}

variable "vpc_id" {
 type = string
}

variable "public_subnet_id" {
 type = string
}

variable "instance_type" {
 type = string
 default = "t3.large"
}

variable "key_pair_name" {
 type = string
 default = ""
}

variable "allowed_ssh_cidr" {
 type = string
 default = "0.0.0.0/0"
}

variable "s3_bucket_arn" {
 type = string
}

variable "domain_name" {
 type = string
}
