resource "aws_vpc" "nova_vpc" {
 cidr_block = var.vpc_cidr
 enable_dns_support = true
 enable_dns_hostnames = true
 enable_network_address_usage_metrics = true

 tags = {
 Name = "${var.project_name}-vpc"
 }
}

resource "aws_internet_gateway" "nova_igw" {
 vpc_id = aws_vpc.nova_vpc.id

 tags = {
 Name = "${var.project_name}-igw"
 }
}

resource "aws_eip" "nat_eip" {
 domain = "vpc"

 tags = {
 Name = "${var.project_name}-nat-eip"
 }
}

resource "aws_nat_gateway" "nova_nat" {
 allocation_id = aws_eip.nat_eip.id
 subnet_id = aws_subnet.public[0].id

 tags = {
 Name = "${var.project_name}-nat-gateway"
 }

 depends_on = [aws_internet_gateway.nova_igw]
}

resource "aws_subnet" "public" {
 count = 2

 vpc_id = aws_vpc.nova_vpc.id
 cidr_block = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
 availability_zone = data.aws_availability_zones.available.names[count.index]
 map_public_ip_on_launch = true

 tags = {
 Name = "${var.project_name}-public-${count.index + 1}"
 Type = "public"
 }
}

resource "aws_subnet" "private" {
 count = 2

 vpc_id = aws_vpc.nova_vpc.id
 cidr_block = cidrsubnet(var.vpc_cidr, 8, 100 + count.index)
 availability_zone = data.aws_availability_zones.available.names[count.index]
 map_public_ip_on_launch = false

 tags = {
 Name = "${var.project_name}-private-${count.index + 1}"
 Type = "private"
 }
}

resource "aws_route_table" "public" {
 vpc_id = aws_vpc.nova_vpc.id

 route {
 cidr_block = "0.0.0.0/0"
 gateway_id = aws_internet_gateway.nova_igw.id
 }

 tags = {
 Name = "${var.project_name}-public-rt"
 }
}

resource "aws_route_table" "private" {
 vpc_id = aws_vpc.nova_vpc.id

 route {
 cidr_block = "0.0.0.0/0"
 nat_gateway_id = aws_nat_gateway.nova_nat.id
 }

 tags = {
 Name = "${var.project_name}-private-rt"
 }
}

resource "aws_route_table_association" "public" {
 count = 2

 subnet_id = aws_subnet.public[count.index].id
 route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
 count = 2

 subnet_id = aws_subnet.private[count.index].id
 route_table_id = aws_route_table.private.id
}

# VPC Flow Logs for security auditing
resource "aws_cloudwatch_log_group" "vpc_flow_logs" {
 name = "/aws/vpc/flow-logs/${var.project_name}"
 retention_in_days = 30
}

resource "aws_iam_role" "vpc_flow_log_role" {
 name = "${var.project_name}-vpc-flow-log-role"

 assume_role_policy = jsonencode({
 Version = "2012-10-17"
 Statement = [{
 Effect = "Allow"
 Principal = { Service = "vpc-flow-logs.amazonaws.com" }
 Action = "sts:AssumeRole"
 }]
 })
}

resource "aws_iam_role_policy" "vpc_flow_log_policy" {
 name = "${var.project_name}-vpc-flow-log-policy"
 role = aws_iam_role.vpc_flow_log_role.id

 policy = jsonencode({
 Version = "2012-10-17"
 Statement = [{
 Effect = "Allow"
 Action = [
 "logs:CreateLogGroup",
 "logs:CreateLogStream",
 "logs:PutLogEvents",
 "logs:DescribeLogGroups",
 "logs:DescribeLogStreams"
 ]
 Resource = "*"
 }]
 })
}

resource "aws_flow_log" "nova_vpc_flow_log" {
 vpc_id = aws_vpc.nova_vpc.id
 traffic_type = "ALL"
 log_destination = aws_cloudwatch_log_group.vpc_flow_logs.arn
 iam_role_arn = aws_iam_role.vpc_flow_log_role.arn
 log_format = "${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status}"
}

data "aws_availability_zones" "available" {
 state = "available"
}
