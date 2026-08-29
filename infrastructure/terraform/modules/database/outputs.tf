output "db_endpoint" {
 value = aws_db_instance.nova_postgres.endpoint
}

output "db_port" {
 value = aws_db_instance.nova_postgres.port
}

output "db_name" {
 value = aws_db_instance.nova_postgres.db_name
}

output "db_username" {
 value = aws_db_instance.nova_postgres.username
}

output "db_password" {
 value = random_password.db_password.result
 sensitive = true
}

output "redis_endpoint" {
 value = aws_elasticache_cluster.nova_redis.cache_nodes[0].address
}

output "redis_port" {
 value = aws_elasticache_cluster.nova_redis.cache_nodes[0].port
}

output "redis_password" {
 value = random_password.redis_password.result
 sensitive = true
}
