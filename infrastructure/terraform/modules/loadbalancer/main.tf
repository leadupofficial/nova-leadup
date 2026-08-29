resource "aws_lb" "nova_alb" {
 name = "${var.project_name}-alb"
 internal = false
 load_balancer_type = "application"
 security_groups = [aws_security_group.lb_sg.id]
 subnets = var.public_subnet_ids
 enable_deletion_protection = true
 enable_cross_zone_load_balancing = true

 access_logs {
 bucket = var.s3_access_logs_bucket
 prefix = "alb-logs"
 enabled = true
 }

 tags = {
 Name = "${var.project_name}-alb"
 }
}

resource "aws_security_group" "lb_sg" {
 name = "${var.project_name}-alb-sg"
 description = "Security group for ALB"
 vpc_id = var.vpc_id

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
 Name = "${var.project_name}-alb-sg"
 }
}

resource "aws_lb_target_group" "nova_api_tg" {
 name = "${var.project_name}-api-tg"
 port = 3001
 protocol = "HTTP"
 target_type = "instance"
 vpc_id = var.vpc_id

 health_check {
 path = "/health/live"
 protocol = "HTTP"
 matcher = "200"
 interval = 30
 timeout = 5
 healthy_threshold = 2
 unhealthy_threshold = 3
 }
}

resource "aws_lb_target_group" "nova_auth_tg" {
 name = "${var.project_name}-auth-tg"
 port = 3003
 protocol = "HTTP"
 target_type = "instance"
 vpc_id = var.vpc_id

 health_check {
 path = "/health/live"
 protocol = "HTTP"
 matcher = "200"
 interval = 30
 timeout = 5
 healthy_threshold = 2
 unhealthy_threshold = 3
 }
}

resource "aws_lb_target_group" "nova_admin_tg" {
 name = "${var.project_name}-admin-tg"
 port = 3004
 protocol = "HTTP"
 target_type = "instance"
 vpc_id = var.vpc_id

 health_check {
 path = "/health/live"
 protocol = "HTTP"
 matcher = "200"
 interval = 30
 timeout = 5
 healthy_threshold = 2
 unhealthy_threshold = 3
 }
}

resource "aws_lb_target_group_attachment" "nova_api" {
 target_group_arn = aws_lb_target_group.nova_api_tg.arn
 target_id = var.app_instance_id
 port = 3001
}

resource "aws_lb_target_group_attachment" "nova_auth" {
 target_group_arn = aws_lb_target_group.nova_auth_tg.arn
 target_id = var.app_instance_id
 port = 3003
}

resource "aws_lb_target_group_attachment" "nova_admin" {
 target_group_arn = aws_lb_target_group.nova_admin_tg.arn
 target_id = var.app_instance_id
 port = 3004
}

# HTTPS listener (requires ACM certificate)
resource "aws_lb_listener" "https" {
 load_balancer_arn = aws_lb.nova_alb.id
 port = 443
 protocol = "HTTPS"
 ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"
 certificate_arn = var.ssl_certificate_arn

 default_action {
 type = "fixed-response"
 fixed_response {
 content_type = "text/plain"
 status_code = "404"
 message_body = "Not Found"
 }
 }

 dynamic "default_action" {
 for_each = var.ssl_certificate_arn != "" ? [1] : []
 content {
 type = "redirect"
 redirect {
 protocol = "HTTPS"
 port = "443"
 status_code = "HTTP_301"
 }
 }
 }
}

# HTTP → HTTPS redirect
resource "aws_lb_listener" "http_redirect" {
 load_balancer_arn = aws_lb.nova_alb.id
 port = 80
 protocol = "HTTP"

 default_action {
 type = "redirect"
 redirect {
 protocol = "HTTPS"
 port = "443"
 status_code = "HTTP_301"
 }
 }
}
