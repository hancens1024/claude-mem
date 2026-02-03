# claude-mem 项目管理 Makefile
# 用于快速管理 claude-mem 数据库中的项目记录

# 数据库路径
DB_PATH := ~/.claude-mem/claude-mem.db
SQLITE := sqlite3 $(DB_PATH)

# 颜色定义
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[0;33m
BLUE := \033[0;34m
NC := \033[0m # No Color

.PHONY: help list delete delete-multi vacuum stats pending clean-pending clean-orphans \
       start stop restart status logs build build-restart

# 默认目标：显示帮助
help:
	@echo "$(BLUE)claude-mem 项目管理命令$(NC)"
	@echo ""
	@echo "$(GREEN)查看命令:$(NC)"
	@echo "  make list              - 列出所有项目及会话数量"
	@echo "  make stats             - 显示数据库统计信息"
	@echo "  make pending           - 显示未处理的消息"
	@echo ""
	@echo "$(GREEN)删除命令:$(NC)"
	@echo "  make delete P=项目名   - 删除指定项目的所有记录"
	@echo "  make delete-multi P=\"项目1 项目2\"  - 删除多个项目"
	@echo "  make clean-pending     - 清理所有未处理的消息"
	@echo "  make clean-orphans     - 清理孤立的消息（会话已删除）"
	@echo ""
	@echo "$(GREEN)Worker 命令:$(NC)"
	@echo "  make start             - 启动 worker"
	@echo "  make stop              - 停止 worker"
	@echo "  make restart           - 重启 worker"
	@echo "  make status            - 查看 worker 状态"
	@echo "  make logs              - 查看最新日志"
	@echo "  make build             - 构建项目"
	@echo "  make build-restart     - 构建并重启 worker"
	@echo ""
	@echo "$(GREEN)维护命令:$(NC)"
	@echo "  make vacuum            - 压缩数据库释放空间"
	@echo ""
	@echo "$(YELLOW)示例:$(NC)"
	@echo "  make delete P=todo-list"
	@echo "  make delete-multi P=\"todo-list todo-list2\""

# 列出所有项目
list:
	@echo "$(BLUE)项目列表 (按会话数量排序):$(NC)"
	@echo ""
	@$(SQLITE) -column -header \
		"SELECT project as '项目名', COUNT(*) as '会话数', \
		MAX(datetime(started_at_epoch, 'unixepoch', 'localtime')) as '最后活动' \
		FROM sdk_sessions GROUP BY project ORDER BY COUNT(*) DESC;"

# 显示数据库统计
stats:
	@echo "$(BLUE)数据库统计:$(NC)"
	@echo ""
	@echo "会话总数: $$($(SQLITE) 'SELECT COUNT(*) FROM sdk_sessions;')"
	@echo "观察记录: $$($(SQLITE) 'SELECT COUNT(*) FROM observations;')"
	@echo "会话摘要: $$($(SQLITE) 'SELECT COUNT(*) FROM session_summaries;')"
	@echo "用户提示: $$($(SQLITE) 'SELECT COUNT(*) FROM user_prompts;')"
	@echo "待处理消息: $$(sqlite3 $(DB_PATH) 'SELECT COUNT(*) FROM pending_messages WHERE status <> "processed"')"
	@echo ""
	@echo "数据库大小: $$(du -h $(DB_PATH) | cut -f1)"

# 显示未处理的消息
pending:
	@echo "$(BLUE)未处理的消息:$(NC)"
	@echo ""
	@$(SQLITE) -column -header \
		"SELECT pm.id, s.project as '项目', pm.status as '状态', \
		pm.message_type as '类型', pm.retry_count as '重试', \
		datetime(pm.created_at_epoch, 'unixepoch', 'localtime') as '创建时间' \
		FROM pending_messages pm \
		JOIN sdk_sessions s ON pm.session_db_id = s.id \
		WHERE pm.status != 'processed' \
		ORDER BY pm.created_at_epoch DESC \
		LIMIT 20;"

# 删除单个项目
delete:
ifndef P
	@echo "$(RED)错误: 请指定项目名$(NC)"
	@echo "用法: make delete P=项目名"
	@exit 1
endif
	@echo "$(YELLOW)将要删除项目: $(P)$(NC)"
	@echo ""
	@echo "影响的记录数:"
	@echo "  会话: $$($(SQLITE) 'SELECT COUNT(*) FROM sdk_sessions WHERE project = \"$(P)\";')"
	@echo "  观察: $$($(SQLITE) 'SELECT COUNT(*) FROM observations WHERE project = \"$(P)\";')"
	@echo "  摘要: $$($(SQLITE) 'SELECT COUNT(*) FROM session_summaries WHERE project = \"$(P)\";')"
	@echo "  待处理: $$($(SQLITE) 'SELECT COUNT(*) FROM pending_messages WHERE session_db_id IN (SELECT id FROM sdk_sessions WHERE project = \"$(P)\");')"
	@echo ""
	@read -p "确认删除? [y/N] " confirm && [ "$$confirm" = "y" ] || exit 1
	@echo "$(BLUE)正在删除...$(NC)"
	@# 删除顺序很重要：先删除子表，再删除主表
	@$(SQLITE) "DELETE FROM pending_messages WHERE session_db_id IN (SELECT id FROM sdk_sessions WHERE project = '$(P)');"
	@$(SQLITE) "DELETE FROM observations WHERE project = '$(P)';"
	@$(SQLITE) "DELETE FROM session_summaries WHERE project = '$(P)';"
	@$(SQLITE) "DELETE FROM sdk_sessions WHERE project = '$(P)';"
	@$(MAKE) -s vacuum
	@echo "$(GREEN)✓ 项目 $(P) 已完全删除$(NC)"

# 删除多个项目
delete-multi:
ifndef P
	@echo "$(RED)错误: 请指定项目名$(NC)"
	@echo "用法: make delete-multi P=\"项目1 项目2\""
	@exit 1
endif
	@echo "$(YELLOW)将要删除以下项目:$(NC)"
	@for proj in $(P); do \
		count=$$($(SQLITE) "SELECT COUNT(*) FROM sdk_sessions WHERE project = '$$proj';"); \
		obs=$$($(SQLITE) "SELECT COUNT(*) FROM observations WHERE project = '$$proj';"); \
		echo "  $$proj: $$count 个会话, $$obs 条观察"; \
	done
	@echo ""
	@read -p "确认删除? [y/N] " confirm && [ "$$confirm" = "y" ] || exit 1
	@echo "$(BLUE)正在删除...$(NC)"
	@for proj in $(P); do \
		$(SQLITE) "DELETE FROM pending_messages WHERE session_db_id IN (SELECT id FROM sdk_sessions WHERE project = '$$proj');"; \
		$(SQLITE) "DELETE FROM observations WHERE project = '$$proj';"; \
		$(SQLITE) "DELETE FROM session_summaries WHERE project = '$$proj';"; \
		$(SQLITE) "DELETE FROM sdk_sessions WHERE project = '$$proj';"; \
		echo "$(GREEN)✓ 已删除: $$proj$(NC)"; \
	done
	@$(MAKE) -s vacuum

# 清理所有未处理的消息
clean-pending:
	@echo "$(YELLOW)将要清理所有未处理的消息$(NC)"
	@count=$$(sqlite3 $(DB_PATH) 'SELECT COUNT(*) FROM pending_messages WHERE status <> "processed"'); \
	echo "待清理数量: $$count"
	@echo ""
	@read -p "确认清理? [y/N] " confirm && [ "$$confirm" = "y" ] || exit 1
	@$(SQLITE) "DELETE FROM pending_messages WHERE status != 'processed';"
	@echo "$(GREEN)✓ 已清理未处理的消息$(NC)"

# 清理孤立的 pending 消息（会话已删除但消息还在）
clean-orphans:
	@echo "$(BLUE)清理孤立的记录...$(NC)"
	@pm_count=$$(sqlite3 $(DB_PATH) 'SELECT COUNT(*) FROM pending_messages WHERE session_db_id NOT IN (SELECT id FROM sdk_sessions)'); \
	obs_count=$$(sqlite3 $(DB_PATH) 'SELECT COUNT(*) FROM observations WHERE memory_session_id NOT IN (SELECT memory_session_id FROM sdk_sessions)'); \
	sum_count=$$(sqlite3 $(DB_PATH) 'SELECT COUNT(*) FROM session_summaries WHERE memory_session_id NOT IN (SELECT memory_session_id FROM sdk_sessions)'); \
	echo "发现 $$pm_count 条 pending 消息, $$obs_count 条观察, $$sum_count 条摘要"
	@$(SQLITE) "DELETE FROM pending_messages WHERE session_db_id NOT IN (SELECT id FROM sdk_sessions);"
	@$(SQLITE) "DELETE FROM observations WHERE memory_session_id NOT IN (SELECT memory_session_id FROM sdk_sessions);"
	@$(SQLITE) "DELETE FROM session_summaries WHERE memory_session_id NOT IN (SELECT memory_session_id FROM sdk_sessions);"
	@echo "$(GREEN)✓ 已清理所有孤立记录$(NC)"
	@$(MAKE) -s vacuum

# 压缩数据库
vacuum:
	@echo "$(BLUE)压缩数据库...$(NC)"
	@size_before=$$(du -h $(DB_PATH) | cut -f1); \
	$(SQLITE) "VACUUM;"; \
	size_after=$$(du -h $(DB_PATH) | cut -f1); \
	echo "$(GREEN)✓ 完成 ($$size_before → $$size_after)$(NC)"

# Worker 项目根目录
PROJ_DIR := ~/.claude/plugins/marketplaces/thedotmack

# 启动 worker
start:
	@echo "$(BLUE)启动 worker...$(NC)"
	@cd $(PROJ_DIR) && npm run worker:start
	@echo "$(GREEN)✓ Worker 已启动$(NC)"

# 停止 worker
stop:
	@echo "$(YELLOW)停止 worker...$(NC)"
	@cd $(PROJ_DIR) && npm run worker:stop
	@echo "$(GREEN)✓ Worker 已停止$(NC)"

# 重启 worker
restart:
	@echo "$(BLUE)重启 worker...$(NC)"
	@cd $(PROJ_DIR) && npm run worker:restart
	@echo "$(GREEN)✓ Worker 已重启$(NC)"

# 查看 worker 状态
status:
	@cd $(PROJ_DIR) && npm run worker:status

# 查看最新日志
logs:
	@tail -50 ~/.claude-mem/logs/claude-mem-$$(date +%Y-%m-%d).log

# 构建项目
build:
	@echo "$(BLUE)构建项目...$(NC)"
	@cd $(PROJ_DIR) && npm run build
	@echo "$(GREEN)✓ 构建完成$(NC)"

# 构建并重启
build-restart: build restart
