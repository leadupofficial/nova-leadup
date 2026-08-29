output "instance_id" {
 value = aws_instance.nova_app_server.id
}

output "public_ip" {
 value = aws_eip.nova_app_eip.public_ip
}

output "instance_profile" {
 value = aws_iam_instance_profile.nova_app_instance_profile.name
}
