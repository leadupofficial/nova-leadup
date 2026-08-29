variable "vpc_cidr" {
 type = string
 default = "10.0.0.0/16"
 description = "CIDR block for the VPC"
}

variable "project_name" {
 type = string
}
