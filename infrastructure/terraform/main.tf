terraform {
 required_version = ">= 1.6.0"

 required_providers {
 aws = {
 source = "hashicorp/aws"
 version = "~> 5.0"
 }
 random = {
 source = "hashicorp/random"
 version = "~> 3.5"
 }
 tls = {
 source = "hashicorp/tls"
 version = "~> 4.0"
 }
 }

 backend "s3" {
 bucket = "nova-terraform-state"
 key = "production/terraform.tfstate"
 region = "us-east-1"
 encrypt = true
 dynamodb_table = "nova-terraform-locks"
 }
}

provider "aws" {
 region = var.aws_region

 default_tags {
 tags = {
 Project = "nova-leadup"
 Environment = "production"
 ManagedBy = "terraform"
 Owner = "leadup-technologies"
 }
 }
}
