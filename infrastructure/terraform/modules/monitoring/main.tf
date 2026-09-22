# NOVA Monitoring Module — CloudWatch alarms and SNS topics

variable "project_name" {
 type = string
}

variable "asg_name" {
 type = string
 default = ""
}

variable "rds_instance_id" {
 type = string
 default = ""
}

variable "redis_replication_group_id" {
 type = string
 default = ""
}

variable "alb_arn_suffix" {
 type = string
 default = ""
}

resource "aws_sns_topic" "alerts" {
 name = "${var.project_name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
 count = var.alarm_email != "" ? 1 : 0
 topic_arn = aws_sns_topic.alerts.arn
 protocol = "email"
 endpoint = var.alarm_email
}

variable "alarm_email" {
 type = string
 default = ""
}

# CPU alarm for ASG
resource "aws_cloudwatch_metric_alarm" "asg_high_cpu" {
 count = var.asg_name != "" ? 1 : 0

 alarm_name = "${var.project_name}-asg-high-cpu"
 comparison_operator = "GreaterThanThreshold"
 evaluation_periods = 2
 metric_name = "CPUUtilization"
 namespace = "AWS/EC2"
 period = 120
 statistic = "Average"
 threshold = 80

 dimensions = {
 AutoScalingGroupName = var.asg_name
 }

 alarm_actions = [aws_sns_topic.alerts.arn]
 treat_missing_data = "notBreaching"
}

# RDS high CPU
resource "aws_cloudwatch_metric_alarm" "rds_high_cpu" {
 count = var.rds_instance_id != "" ? 1 : 0

 alarm_name = "${var.project_name}-rds-high-cpu"
 comparison_operator = "GreaterThanThreshold"
 evaluation_periods = 2
 metric_name = "CPUUtilization"
 namespace = "AWS/RDS"
 period = 120
 statistic = "Average"
 threshold = 80

 dimensions = {
 DBInstanceIdentifier = var.rds_instance_id
 }

 alarm_actions = [aws_sns_topic.alerts.arn]
 treat_missing_data = "notBreaching"
}

# Redis replication lag alarm
resource "aws_cloudwatch_metric_alarm" "redis_replication_lag" {
 count = var.redis_replication_group_id != "" ? 1 : 0

 alarm_name = "${var.project_name}-redis-replication-lag"
 comparison_operator = "GreaterThanThreshold"
 evaluation_periods = 2
 metric_name = "ReplicationLag"
 namespace = "AWS/ElastiCache"
 period = 60
 statistic = "Average"
 threshold = 5

 dimensions = {
 ReplicationGroupId = var.redis_replication_group_id
 }

 alarm_actions = [aws_sns_topic.alerts.arn]
 treat_missing_data = "notBreaching"
}

# ALB 5xx alarm
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
 count = var.alb_arn_suffix != "" ? 1 : 0

 alarm_name = "${var.project_name}-alb-5xx"
 comparison_operator = "GreaterThanThreshold"
 evaluation_periods = 2
 metric_name = "HTTPCode_ELB_5XX_Count"
 namespace = "AWS/ApplicationELB"
 period = 60
 statistic = "Sum"
 threshold = 10

 dimensions = {
 LoadBalancer = var.alb_arn_suffix
 }

 alarm_actions = [aws_sns_topic.alerts.arn]
 treat_missing_data = "notBreaching"
}
