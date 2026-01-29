/**
 * AnthropicAPIAgent: Anthropic Messages API 直连 agent
 *
 * 使用 Anthropic Messages API 格式直接调用兼容的 API 端点
 * 支持自定义 base URL 用于代理服务
 *
 * Responsibility:
 * - 调用 Anthropic Messages API 进行 observation 提取
 * - 解析 XML 响应 (与 Claude/Gemini 格式相同)
 * - 同步到数据库和 Chroma
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage, PendingMessageWithId } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

// 默认 Anthropic API 端点
const DEFAULT_ANTHROPIC_API_URL = 'https://api.anthropic.com';

// Context window 管理常量
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_CONCURRENCY = 3;

// 并发限制器
class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // 等待可用槽位
    if (this.running >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }

    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      // 释放下一个等待的任务
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// Anthropic Messages API 消息格式
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: Array<{
    type: string;
    text?: string;
  }>;
  model?: string;
  stop_reason?: string;
  stop_sequence?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    type?: string;
    message?: string;
  };
}

export class AnthropicAPIAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * 设置 fallback agent (用于 API 失败时)
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * 启动 session 的 Anthropic API agent
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // 获取 Anthropic API 配置
      const { apiKey, model, baseUrl, concurrency } = this.getAnthropicConfig();

      if (!apiKey) {
        throw new Error('Anthropic API key not configured. Set CLAUDE_MEM_ANTHROPIC_API_KEY in settings.');
      }

      // 确保有 memorySessionId
      // Anthropic API 直连不返回 session_id，所以需要自己管理
      if (!session.memorySessionId) {
        // 先从数据库检查是否已有 memory_session_id
        const dbSession = this.dbManager.getSessionStore().getSessionById(session.sessionDbId);
        if (dbSession?.memory_session_id) {
          // 使用数据库中已有的 memory_session_id（保持 FOREIGN KEY 约束兼容性）
          session.memorySessionId = dbSession.memory_session_id;
          logger.info('SDK', `MEMORY_ID_RESTORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId}`, {
            sessionId: session.sessionDbId,
            memorySessionId: session.memorySessionId
          });
        } else {
          // 数据库中没有，生成新的并持久化
          session.memorySessionId = crypto.randomUUID();
          this.dbManager.getSessionStore().updateMemorySessionId(
            session.sessionDbId,
            session.memorySessionId
          );
          logger.info('SDK', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId}`, {
            sessionId: session.sessionDbId,
            memorySessionId: session.memorySessionId
          });
        }
      }

      // 加载 active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // 构建初始 prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // 添加到会话历史并查询 API
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryAnthropicMultiTurn(session.conversationHistory, apiKey, model, baseUrl);

      if (initResponse.content) {
        // 添加响应到会话历史
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        // 跟踪 token 使用
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += initResponse.inputTokens || 0;
        session.cumulativeOutputTokens += initResponse.outputTokens || 0;

        // 使用共享的 ResponseProcessor 处理响应
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Anthropic API',
          undefined
        );
      } else {
        logger.error('SDK', 'Empty Anthropic API init response', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // 跟踪 lastCwd
      let lastCwd: string | undefined;

      // 创建并发限制器
      const limiter = new ConcurrencyLimiter(concurrency);

      logger.info('SDK', `Anthropic API concurrent processing enabled`, {
        sessionId: session.sessionDbId,
        concurrency
      });

      // 并发处理：使用 Promise 池而不是等待批次满
      const pendingTasks: Promise<void>[] = [];

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        if (message.cwd) {
          lastCwd = message.cwd;
        }

        const originalTimestamp = session.earliestPendingTimestamp;
        const messageCwd = message.cwd || lastCwd;

        // 立即启动处理任务，通过 limiter 控制并发
        const task = this.processMessageConcurrently(
          message,
          session,
          apiKey,
          model,
          baseUrl,
          mode,
          limiter,
          originalTimestamp,
          worker,
          messageCwd
        );

        pendingTasks.push(task);

        // 定期清理已完成的 Promise，避免内存泄漏
        if (pendingTasks.length >= concurrency * 3) {
          // 等待至少一个任务完成
          await Promise.race(pendingTasks);
          // 过滤掉已完成的任务（通过检查 Promise 状态）
          const stillPending: Promise<void>[] = [];
          for (const p of pendingTasks) {
            const settled = await Promise.race([p.then(() => true), Promise.resolve(false)]);
            if (!settled) {
              stillPending.push(p);
            }
          }
          pendingTasks.length = 0;
          pendingTasks.push(...stillPending);
        }
      }

      // 等待所有剩余任务完成
      if (pendingTasks.length > 0) {
        await Promise.all(pendingTasks);
      }

    } catch (error) {
      if (isAbortError(error)) {
        logger.info('SDK', 'Anthropic API agent aborted', { sessionId: session.sessionDbId });
        return;
      }

      logger.error('SDK', 'Anthropic API agent error', {
        sessionDbId: session.sessionDbId,
        errorMessage: (error as Error).message,
        errorName: (error as Error).name,
        errorType: Object.prototype.toString.call(error),
        errorStack: (error as Error).stack?.split('\n').slice(0, 5).join(' | ')
      }, error as Error);

      // 检查是否应该回退到 Claude SDK
      if (shouldFallbackToClaude(error as Error) && this.fallbackAgent) {
        logger.info('SDK', 'Falling back to Claude SDK', { sessionId: session.sessionDbId });
        return this.fallbackAgent.startSession(session, worker);
      }

      throw error;
    }
  }

  /**
   * 并发处理单条消息
   * 使用并发限制器控制同时进行的 API 调用数量
   * 每条消息独立处理，通过 limiter 控制并发
   */
  private async processMessageConcurrently(
    message: PendingMessageWithId,
    session: ActiveSession,
    apiKey: string,
    model: string,
    baseUrl: string,
    mode: ModeConfig,
    limiter: ConcurrencyLimiter,
    originalTimestamp: number | null,
    worker?: WorkerRef,
    lastCwd?: string
  ): Promise<void> {
    // 通过 limiter 控制并发
    return limiter.run(async () => {
      try {
        let prompt: string;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          prompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });
        } else if (message.type === 'summarize') {
          prompt = buildSummaryPrompt(
            session.project,
            mode,
            message.last_assistant_message
          );
        } else {
          return;
        }

        logger.info('SDK', `Processing message concurrently`, {
          sessionId: session.sessionDbId,
          messageType: message.type,
          toolName: message.tool_name
        });

        // 每个并发任务使用独立的 context（只包含初始 prompt）
        // 这避免了并发时 conversationHistory 的冲突
        const independentHistory: ConversationMessage[] = [
          ...session.conversationHistory.slice(0, 2), // 保留初始 prompt 和响应
          { role: 'user', content: prompt }
        ];

        const response = await this.queryAnthropicMultiTurn(
          independentHistory,
          apiKey,
          model,
          baseUrl
        );

        if (response?.content) {
          // 更新会话历史（通过锁或顺序处理避免冲突）
          session.conversationHistory.push({ role: 'user', content: prompt });
          session.conversationHistory.push({ role: 'assistant', content: response.content });

          // 跟踪 token 使用
          const tokensUsed = response.tokensUsed || 0;
          session.cumulativeInputTokens += response.inputTokens || 0;
          session.cumulativeOutputTokens += response.outputTokens || 0;

          // 处理响应
          await processAgentResponse(
            response.content,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Anthropic API',
            lastCwd
          );

          logger.info('SDK', `Message processed successfully`, {
            sessionId: session.sessionDbId,
            messageType: message.type,
            tokensUsed
          });
        }

        // 清除已处理消息的时间戳
        session.earliestPendingTimestamp = null;

      } catch (error) {
        logger.error('SDK', 'Concurrent message processing failed', {
          sessionId: session.sessionDbId,
          messageType: message.type,
          error: (error as Error).message
        });
        // 不抛出错误，让其他消息继续处理
      }
    });
  }

  /**
   * 获取 Anthropic API 配置
   */
  private getAnthropicConfig(): { apiKey: string; model: string; baseUrl: string; concurrency: number } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const apiKey = settings.CLAUDE_MEM_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    const model = settings.CLAUDE_MEM_ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const baseUrl = settings.CLAUDE_MEM_ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_API_URL;
    const concurrency = parseInt(settings.CLAUDE_MEM_ANTHROPIC_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10);

    return { apiKey, model, baseUrl, concurrency };
  }

  /**
   * 估算 token 数量
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * 截断历史以防止 context 溢出
   */
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES || String(DEFAULT_MAX_CONTEXT_MESSAGES), 10);
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS || String(DEFAULT_MAX_ESTIMATED_TOKENS), 10);

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      return history;
    }

    // 保留第一条消息 (system context) 和最近的消息
    const firstMessage = history[0];
    const recentMessages = history.slice(-MAX_CONTEXT_MESSAGES + 1);

    const truncated: ConversationMessage[] = [firstMessage];
    let tokenCount = this.estimateTokens(firstMessage.content);

    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const msg = recentMessages[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: history.length - truncated.length,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    return truncated;
  }

  /**
   * 转换为 Anthropic 消息格式
   */
  private conversationToAnthropicMessages(history: ConversationMessage[]): AnthropicMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  /**
   * 使用 Anthropic Messages API 进行多轮对话查询
   */
  private async queryAnthropicMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    baseUrl: string
  ): Promise<{ content: string; tokensUsed?: number; inputTokens?: number; outputTokens?: number }> {
    // 截断历史以防止成本失控
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToAnthropicMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying Anthropic API multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens,
      baseUrl
    });

    // 构建 API URL
    const apiUrl = `${baseUrl}/v1/messages`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as AnthropicResponse;

    // 检查响应中的错误
    if (data.error) {
      throw new Error(`Anthropic API error: ${data.error.type} - ${data.error.message}`);
    }

    // 提取内容
    const content = data.content?.find(c => c.type === 'text')?.text || '';

    if (!content) {
      logger.error('SDK', 'Empty response from Anthropic API');
      return { content: '' };
    }

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const tokensUsed = inputTokens + outputTokens;

    // 记录 token 使用
    logger.info('SDK', 'Anthropic API usage', {
      model,
      inputTokens,
      outputTokens,
      totalTokens: tokensUsed,
      messagesInContext: truncatedHistory.length
    });

    // 警告高成本
    if (tokensUsed > 50000) {
      logger.warn('SDK', 'High token usage in single request', {
        tokensUsed,
        model,
        warningThreshold: 50000
      });
    }

    return { content, tokensUsed, inputTokens, outputTokens };
  }
}

/**
 * 检查是否应该使用 Anthropic API provider
 */
export function isAnthropicAPIProvider(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'anthropic-api';
}
