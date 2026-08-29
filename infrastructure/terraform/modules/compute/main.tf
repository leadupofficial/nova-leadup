resource "aws_security_group" "nova_app_sg" {
 name = "${var.project_name}-app-sg"
 description = "Security group for Nova application server"
 vpc_id = var.vpc_id

 ingress {
 from_port = 22
 to_port = 22
 protocol = "tcp"
 cidr_blocks = [var.allowed_ssh_cidr]
 }

 ingress {
 from_port = 80
 to_port = 80
 protocol = "tcp"
 cidr_blocks = ["0.0.0.0/0"]
 }

 ingress {
 from_port = 443
 to_port = 443
 protocol = "tcp"
 cidr_blocks = ["0.0.0.0/0"]
 }

 egress {
 from_port = 0
 to_port = 0
 protocol = "-1"
 cidr_blocks = ["0.0.0.0/0"]
 }

 tags = {
 Name = "${var.project_name}-app-sg"
 }
}

resource "aws_iam_role" "nova_app_instance_role" {
 name = "${var.project_name}-app-instance-role"

 assume_role_policy = jsonencode({
 Version = "2012-10-17"
 Statement = [{
 Effect = "Allow"
 Principal = { Service = "ec2.amazonaws.com" }
 Action = "sts:AssumeRole"
 }]
 })
}

resource "aws_iam_role_policy_attachment" "app_ssm_core" {
 role = aws_iam_role.nova_app_instance_role.name
 policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "app_cloudwatch_agent" {
 role = aws_iam_role.nova_app_instance_role.name
 policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_policy" "nova_s3_access" {
 name = "${var.project_name}-s3-access"

 policy = jsonencode({
 Version = "2012-10-17"
 Statement = [
 {
 Effect = "Allow"
 Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
 Resource = [
 var.s3_bucket_arn,
 "${var.s3_bucket_arn}/*"
 ]
 },
 {
 Effect = "Allow"
 Action = ["s3:ListAllMyBuckets"]
 Resource = "*"
 }
 ]
 })
}

resource "aws_iam_role_policy_attachment" "app_s3_access" {
 role = aws_iam_role.nova_app_instance_role.name
 policy_arn = aws_iam_policy.nova_s3_access.arn
}

resource "aws_iam_instance_profile" "nova_app_instance_profile" {
 name = "${var.project_name}-app-instance-profile"
 role = aws_iam_role.nova_app_instance_role.name
}

resource "aws_instance" "nova_app_server" {
 ami = data.aws_ami.amazon_linux_2.id
 instance_type = var.instance_type
 subnet_id = var.public_subnet_id
 vpc_security_group_ids = [aws_security_group.nova_app_sg.id]
 key_name = var.key_pair_name != "" ? var.key_pair_name : null
 iam_instance_profile = aws_iam_instance_profile.nova_app_instance_profile.name

 root_block_device {
 volume_type = "gp3"
 volume_size = 30
 encrypted = true
 }

 user_data = base64encode(templatefile("${path.module}/user-data.sh", {
 project_name = var.project_name
 domain_name = var.domain_name
 }))

 tags = {
 Name = "${var.project_name}-app-server"
 }
}

resource "aws_eip" "nova_app_eip" {
 instance = aws_instance.nova_app_server.id
 vpc = true

 tags = {
 Name = "${var.project_name}-app-eip"
 }
}

data "aws_ami" "amazon_linux_2" {
 most_recent = true
 owners = ["amazon"]

 filter {
 name = "name"
 values = ["amzn2-ami-hvm-*-x86_64-gp2"]
 }

 filter {
 name = "virtualization-type"
 values = ["hvm"]
 }
}
