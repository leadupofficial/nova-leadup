# NOVA Leadup — Terraform Providers
# Shared provider configuration for all modules.
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
 kubernetes = {
 source = "hashicorp/kubernetes"
 version = "~> 2.30"
 }
 helm = {
 source = "hashicorp/helm"
 version = "~> 2.12"
 }
 }
}

# AWS Provider
provider "aws" {
 region = var.aws_region

 default_tags {
 tags = {
 Project = "nova-leadup"
 Environment = var.environment
 ManagedBy = "terraform"
 Owner = "leadup-technologies"
 }
 }
}

# Kubernetes Provider (for deploying workloads to EKS or existing cluster)
provider "kubernetes" {
 config_path = var.kubeconfig_path != "" ? var.kubeconfig_path : null
 host = var.kubernetes_host
 cluster_ca_certificate = var.kubernetes_cluster_ca_cert
 exec {
 api_version = "client.authentication.k8s.io/v1beta1"
 command = "aws"
 args = [
 "eks",
 "get-token",
 "--cluster-name",
 var.eks_cluster_name,
 "--region",
 var.aws_region,
 ]
 }
}

# Helm Provider
provider "helm" {
 kubernetes {
 config_path = var.kubeconfig_path != "" ? var.kubeconfig_path : null
 host = var.kubernetes_host
 cluster_ca_certificate = var.kubernetes_cluster_ca_cert
 exec {
 api_version = "client.authentication.k8s.io/v1beta1"
 command = "aws"
 args = [
 "eks",
 "get-token",
 "--cluster-name",
 var.eks_cluster_name,
 "--region",
 var.aws_region,
 ]
 }
 }
}
