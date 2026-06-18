#!/usr/bin/env node

/**
 * Feishu Blocks MCP Server
 *
 * 补充官方飞书 MCP 缺失的功能：
 * - 获取文档块 (Document Blocks)
 * - 下载媒体文件 (Media Download)
 * - 追加富文本块（表格、图片、嵌入对象）
 * - 创建/写入电子表格和多维表格
 *
 * 认证优先级：
 * 1. FEISHU_USER_ACCESS_TOKEN 环境变量（直接使用）
 * 2. 从 lark-mcp 加密存储读取 user_access_token（自动刷新）
 * 3. tenant_access_token（兜底，需文档授权给应用）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// 飞书 OpenAPI 基础配置
const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

// Bypass OneCLI proxy — it only handles Claude API; Feishu calls must go direct.
const feishuHttp = axios.create({ proxy: false });

// 从环境变量获取配置
const APP_ID = process.env.FEISHU_APP_ID || "";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const USER_ACCESS_TOKEN = process.env.FEISHU_USER_ACCESS_TOKEN || "";

// ─── LarkMcpTokenBridge ───────────────────────────────────────────────
// 从官方 lark-mcp 的加密存储中读取 user_access_token，过期时自动刷新

interface LarkMcpStorageData {
  tokens: Record<string, LarkMcpTokenEntry>;
  clients: Record<string, unknown>;
  localTokens: Record<string, string>;
}

interface LarkMcpTokenEntry {
  clientId: string;
  token: string;
  scopes: string[];
  expiresAt: number;
  extra: {
    refreshToken: string;
    token?: {
      code: number;
      data: {
        access_token: string;
        token_type: string;
        refresh_token: string;
        expires_in: number;
        refresh_expires_in: number;
        scope: string;
      };
    };
    appId: string;
    appSecret: string;
  };
}

class LarkMcpTokenBridge {
  private appId: string;
  private appSecret: string;
  private cachedToken: string | null = null;
  private cachedTokenExpiresAt: number = 0;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  /**
   * 获取 lark-mcp 存储目录（跨平台）
   * 与 env-paths('lark-mcp') 输出一致
   */
  private getStorageDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const platform = process.platform;
    if (platform === "darwin") {
      return path.join(
        home,
        "Library",
        "Application Support",
        "lark-mcp-nodejs"
      );
    } else if (platform === "win32") {
      const appData =
        process.env.APPDATA || path.join(home, "AppData", "Roaming");
      return path.join(appData, "lark-mcp-nodejs", "Data");
    } else {
      const dataHome =
        process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
      return path.join(dataHome, "lark-mcp-nodejs");
    }
  }

  /**
   * 从系统钥匙串读取 AES 加密密钥
   * macOS: 使用 security CLI（零依赖）
   */
  private getKeychainKey(): string | null {
    try {
      if (process.platform === "darwin") {
        return execSync(
          'security find-generic-password -s "lark-mcp" -a "encryption-key" -w',
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
      }
      console.error(
        "[TokenBridge] 非 macOS 平台，暂不支持从钥匙串读取密钥"
      );
      return null;
    } catch {
      console.error("[TokenBridge] 从钥匙串读取密钥失败（lark-mcp 可能未登录）");
      return null;
    }
  }

  /**
   * AES-256-CBC 解密（与 lark-mcp 加密格式一致）
   * 格式：iv_hex:encrypted_hex
   */
  private decrypt(encryptedData: string, aesKey: string): string {
    const parts = encryptedData.split(":");
    if (parts.length !== 2) throw new Error("Invalid encrypted data format");
    const iv = Buffer.from(parts[0], "hex");
    const key = Buffer.from(aesKey, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(parts[1], "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  /**
   * AES-256-CBC 加密（与 lark-mcp 加密格式一致）
   */
  private encrypt(data: string, aesKey: string): string {
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(aesKey, "hex");
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    let encrypted = cipher.update(data, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  }

  /**
   * 读取并解密 lark-mcp 的 storage.json
   */
  private readStorage(): {
    storageData: LarkMcpStorageData;
    aesKey: string;
  } | null {
    const aesKey = this.getKeychainKey();
    if (!aesKey) return null;

    const storageFile = path.join(this.getStorageDir(), "storage.json");
    if (!fs.existsSync(storageFile)) {
      console.error("[TokenBridge] lark-mcp storage.json 不存在");
      return null;
    }

    const encryptedData = fs.readFileSync(storageFile, "utf8");
    const storageData = JSON.parse(
      this.decrypt(encryptedData, aesKey)
    ) as LarkMcpStorageData;
    return { storageData, aesKey };
  }

  /**
   * 加密并保存回 lark-mcp 的 storage.json
   */
  private saveStorage(storageData: LarkMcpStorageData, aesKey: string): void {
    const storageFile = path.join(this.getStorageDir(), "storage.json");
    const encrypted = this.encrypt(
      JSON.stringify(storageData, null, 2),
      aesKey
    );
    fs.writeFileSync(storageFile, encrypted);
  }

  /**
   * 获取 app_access_token（用于刷新 user_access_token）
   */
  private async getAppAccessToken(): Promise<string> {
    const response = await feishuHttp.post(
      `${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`,
      { app_id: this.appId, app_secret: this.appSecret }
    );
    if (response.data.code === 0) {
      return response.data.app_access_token;
    }
    throw new Error(`获取 app_access_token 失败: ${response.data.msg}`);
  }

  /**
   * 使用 refresh_token 刷新 user_access_token
   */
  private async refreshToken(
    refreshToken: string
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    refreshExpiresIn: number;
    scope: string;
  } | null> {
    try {
      const appToken = await this.getAppAccessToken();
      const response = await feishuHttp.post(
        `${FEISHU_BASE_URL}/authen/v1/oidc/refresh_access_token`,
        { grant_type: "refresh_token", refresh_token: refreshToken },
        {
          headers: {
            Authorization: `Bearer ${appToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (response.data.code === 0) {
        const data = response.data.data;
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresIn: data.expires_in,
          refreshExpiresIn: data.refresh_expires_in,
          scope: data.scope,
        };
      }
      console.error(
        `[TokenBridge] 刷新 token 失败: ${response.data.msg} (code: ${response.data.code})`
      );
      return null;
    } catch (error) {
      console.error(`[TokenBridge] 刷新 token 请求异常: ${error}`);
      return null;
    }
  }

  /**
   * 主方法：获取有效的 user_access_token
   * 1. 先检查内存缓存
   * 2. 从 lark-mcp 存储读取
   * 3. 过期则用 refresh_token 刷新并回写存储
   */
  async getUserAccessToken(): Promise<string | null> {
    // 内存缓存命中且未过期（提前 5 分钟刷新）
    const now = Date.now() / 1000;
    if (this.cachedToken && this.cachedTokenExpiresAt > now + 300) {
      return this.cachedToken;
    }

    const storage = this.readStorage();
    if (!storage) return null;

    const { storageData, aesKey } = storage;
    const tokenKey = storageData.localTokens?.[this.appId];
    if (!tokenKey) {
      console.error(
        `[TokenBridge] lark-mcp 存储中未找到 appId=${this.appId} 的 token（需先运行 npx @larksuiteoapi/lark-mcp login）`
      );
      return null;
    }

    const tokenData = storageData.tokens?.[tokenKey];
    if (!tokenData) {
      console.error("[TokenBridge] token 数据结构异常");
      return null;
    }

    // token 未过期，直接使用
    if (tokenData.expiresAt && tokenData.expiresAt > now + 300) {
      console.error("[TokenBridge] 使用 lark-mcp 的 user_access_token（有效）");
      this.cachedToken = tokenData.token;
      this.cachedTokenExpiresAt = tokenData.expiresAt;
      return tokenData.token;
    }

    // token 已过期，尝试刷新
    const oldRefreshToken = tokenData.extra?.refreshToken;
    if (!oldRefreshToken) {
      console.error("[TokenBridge] 无 refresh_token，无法刷新");
      return null;
    }

    console.error("[TokenBridge] user_access_token 已过期，正在刷新...");
    const refreshed = await this.refreshToken(oldRefreshToken);
    if (!refreshed) {
      console.error(
        "[TokenBridge] 刷新失败（refresh_token 可能已过期，需重新运行 npx @larksuiteoapi/lark-mcp login）"
      );
      return null;
    }

    // 更新 lark-mcp 存储（保持两个 MCP Server 同步）
    const newExpiresAt = now + refreshed.expiresIn;
    const newTokenEntry: LarkMcpTokenEntry = {
      clientId: tokenData.clientId,
      token: refreshed.accessToken,
      scopes: refreshed.scope.split(" "),
      expiresAt: newExpiresAt,
      extra: {
        refreshToken: refreshed.refreshToken,
        token: {
          code: 0,
          data: {
            access_token: refreshed.accessToken,
            token_type: "Bearer",
            refresh_token: refreshed.refreshToken,
            expires_in: refreshed.expiresIn,
            refresh_expires_in: refreshed.refreshExpiresIn,
            scope: refreshed.scope,
          },
        },
        appId: this.appId,
        appSecret: this.appSecret,
      },
    };

    // 替换旧 token，写入新 token
    delete storageData.tokens[tokenKey];
    storageData.tokens[refreshed.accessToken] = newTokenEntry;
    storageData.localTokens[this.appId] = refreshed.accessToken;

    try {
      this.saveStorage(storageData, aesKey);
      console.error("[TokenBridge] token 已刷新并回写 lark-mcp 存储");
    } catch (error) {
      console.error(`[TokenBridge] 回写存储失败（不影响本次使用）: ${error}`);
    }

    this.cachedToken = refreshed.accessToken;
    this.cachedTokenExpiresAt = newExpiresAt;
    return refreshed.accessToken;
  }
}

// ─── FeishuConfig ─────────────────────────────────────────────────────

interface FeishuConfig {
  appId: string;
  appSecret: string;
  userAccessToken?: string;
  accessToken?: string;
  tokenExpireTime?: number;
}

// ─── FeishuBlocksMCPServer ────────────────────────────────────────────

class FeishuBlocksMCPServer {
  private server: Server;
  private config: FeishuConfig;
  private tokenBridge: LarkMcpTokenBridge;

  constructor() {
    this.config = {
      appId: APP_ID,
      appSecret: APP_SECRET,
      userAccessToken: USER_ACCESS_TOKEN || undefined,
    };

    this.tokenBridge = new LarkMcpTokenBridge(APP_ID, APP_SECRET);

    this.server = new Server(
      {
        name: "feishu-blocks-mcp",
        version: "1.3.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * 获取飞书访问令牌
   *
   * 优先级：
   * 1. FEISHU_USER_ACCESS_TOKEN 环境变量
   * 2. 从 lark-mcp 存储读取 user_access_token（自动刷新）
   * 3. tenant_access_token（兜底）
   */
  private async getAccessToken(): Promise<string> {
    // 1. 环境变量中的 user_access_token
    if (this.config.userAccessToken) {
      console.error("使用环境变量中的 user_access_token");
      return this.config.userAccessToken;
    }

    // 2. 从 lark-mcp 存储读取（含自动刷新）
    try {
      const userToken = await this.tokenBridge.getUserAccessToken();
      if (userToken) {
        return userToken;
      }
    } catch (error) {
      console.error(`[TokenBridge] 读取失败，降级到 tenant_access_token: ${error}`);
    }

    // 3. 兜底：tenant_access_token
    if (
      this.config.accessToken &&
      this.config.tokenExpireTime &&
      Date.now() < this.config.tokenExpireTime
    ) {
      return this.config.accessToken;
    }

    console.error("使用 tenant_access_token（兜底）");
    const response = await feishuHttp.post(
      `${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`,
      {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }
    );

    if (response.data.code === 0) {
      const token = response.data.tenant_access_token;
      this.config.accessToken = token;
      this.config.tokenExpireTime =
        Date.now() + (response.data.expire - 300) * 1000;
      return token;
    } else {
      throw new Error(
        `获取 access_token 失败: ${response.data.msg || "未知错误"}`
      );
    }
  }

  /**
   * 获取电子表格的工作表列表（v2 metainfo API）
   * 返回 sheets 数组，失败时返回 null
   */
  private async fetchSheetsMeta(
    spreadsheetToken: string,
    accessToken: string
  ): Promise<{
    properties: any;
    sheets: Array<{
      sheetId: string;
      title: string;
      index: number;
      rowCount: number;
      columnCount: number;
    }>;
  } | null> {
    try {
      const response = await feishuHttp.get(
        `${FEISHU_BASE_URL}/sheets/v2/spreadsheets/${spreadsheetToken}/metainfo`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (response.data.code === 0 && response.data.data) {
        return response.data.data;
      }
      console.error(
        `[fetchSheetsMeta] v2 metainfo 返回错误: ${response.data.msg || response.data.code}`
      );
      return null;
    } catch (error) {
      console.error(`[fetchSheetsMeta] v2 metainfo 请求失败: ${error}`);
      return null;
    }
  }

  /**
   * 将列号转为 Excel 字母（1->A, 26->Z, 27->AA...）
   */
  private colToLetter(col: number): string {
    let letter = "";
    while (col > 0) {
      col--;
      letter = String.fromCharCode(65 + (col % 26)) + letter;
      col = Math.floor(col / 26);
    }
    return letter;
  }

  /**
   * 设置请求处理器
   */
  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.getTools(),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "feishu_get_document_blocks":
            return await this.getDocumentBlocks(args);
          case "feishu_get_document_comments":
            return await this.getDocumentComments(args);
          case "feishu_get_block_children":
            return await this.getBlockChildren(args);
          case "feishu_download_media":
            return await this.downloadMedia(args);
          case "feishu_get_spreadsheet_info":
            return await this.getSpreadsheetInfo(args);
          case "feishu_get_board_theme":
            return await this.getBoardTheme(args);
          case "feishu_get_board_thumbnail":
            return await this.getBoardThumbnail(args);
          case "feishu_get_board_nodes":
            return await this.getBoardNodes(args);
          case "feishu_get_sheet_meta":
            return await this.getSheetMeta(args);
          case "feishu_read_spreadsheet_range":
            return await this.readSpreadsheetRange(args);
          case "feishu_create_document":
            return await this.createDocument(args);
          case "feishu_append_blocks":
            return await this.appendBlocks(args);
          case "feishu_create_spreadsheet":
            return await this.createSpreadsheet(args);
          case "feishu_write_spreadsheet":
            return await this.writeSpreadsheet(args);
          case "feishu_create_bitable":
            return await this.createBitable(args);
          case "feishu_create_bitable_table":
            return await this.createBitableTable(args);
          case "feishu_write_bitable_records":
            return await this.writeBitableRecords(args);
          case "feishu_upload_image":
            return await this.uploadImage(args);
          default:
            throw new Error(`未知工具: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `错误: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * 定义所有工具
   */
  private getTools(): Tool[] {
    return [
      {
        name: "feishu_get_document_blocks",
        description:
          "获取飞书文档的所有块。块是文档的基本组成单元，包括文本、图片、表格等。用于获取文档的完整结构和内容。",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "string",
              description: "文档 ID（docx 文档的 obj_token）",
            },
            page_size: {
              type: "number",
              description: "分页大小，默认 500",
              default: 500,
            },
            page_token: {
              type: "string",
              description: "分页标记，用于获取下一页",
            },
          },
          required: ["document_id"],
        },
      },
      {
        name: "feishu_get_document_comments",
        description:
          "获取飞书云文档上的评论/批注（PM 在文档里划词写的意见、全文评论）。这是文档正文 blocks 之外的独立数据——feishu_get_document_blocks 读不到评论，要看评论必须用本工具。默认遍历「局部/全文 × 已解决/未解决」全部组合并按 comment_id 去重，保证不漏；返回每条评论的锚定文字(quote)和各条回复的纯文本。",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "string",
              description:
                "云文档 token（docx 文档的 obj_token，即文档 URL /docx/ 后面那一段；wiki 节点会自动解析）",
            },
            file_type: {
              type: "string",
              enum: ["docx", "doc", "sheet", "file", "slides"],
              description: "云文档类型，默认 docx",
              default: "docx",
            },
            is_whole: {
              type: "boolean",
              description:
                "是否只取全文评论。不传则局部(划词批注)和全文评论都取——PM 划词写的批注属于局部评论",
            },
            is_solved: {
              type: "boolean",
              description: "是否只取已解决的评论。不传则已解决和未解决都取",
            },
            page_size: {
              type: "number",
              description: "每页大小，最大 100，默认 100",
              default: 100,
            },
          },
          required: ["document_id"],
        },
      },
      {
        name: "feishu_get_block_children",
        description:
          "获取指定块的子块。用于递归获取嵌套的块内容，如获取某个容器块内的所有子元素。",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "string",
              description: "文档 ID",
            },
            block_id: {
              type: "string",
              description: "块 ID，如果为空则使用文档 ID 作为根块",
            },
            page_size: {
              type: "number",
              description: "分页大小，默认 500",
              default: 500,
            },
            page_token: {
              type: "string",
              description: "分页标记",
            },
          },
          required: ["document_id"],
        },
      },
      {
        name: "feishu_download_media",
        description:
          "下载飞书媒体文件（图片、视频等）。返回媒体文件的内容或下载链接。通常配合文档块使用，从图片块中提取 file_token 后下载图片。",
        inputSchema: {
          type: "object",
          properties: {
            file_token: {
              type: "string",
              description: "文件 token（从图片块等媒体块中获取）",
            },
            return_type: {
              type: "string",
              enum: ["url", "base64"],
              description: "返回类型：url（临时下载链接）或 base64（文件内容）",
              default: "url",
            },
          },
          required: ["file_token"],
        },
      },
      {
        name: "feishu_get_spreadsheet_info",
        description:
          "获取飞书电子表格信息，包括标题和所有工作表列表（sheet_id、标题、行列数）。这是读取电子表格的第一步——获取到 sheet_id 后可传给 feishu_read_spreadsheet_range。spreadsheet_token 可从文档块中的 Grid 类型块或电子表格 URL 中获取。",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_token: {
              type: "string",
              description: "电子表格的 token（从文档 Grid 块或电子表格 URL 中获取）",
            },
          },
          required: ["spreadsheet_token"],
        },
      },
      {
        name: "feishu_get_board_theme",
        description:
          "获取飞书画板主题信息。返回画板的主题配置（如背景色、样式等）。whiteboard_id 可从文档块中的画板类型块获取。",
        inputSchema: {
          type: "object",
          properties: {
            whiteboard_id: {
              type: "string",
              description: "画板 ID（从文档画板块或画板 URL 中获取）",
            },
          },
          required: ["whiteboard_id"],
        },
      },
      {
        name: "feishu_get_board_thumbnail",
        description:
          "获取飞书画板缩略图。将画板内容导出为图片。返回图片的 base64 数据或临时下载链接。",
        inputSchema: {
          type: "object",
          properties: {
            whiteboard_id: {
              type: "string",
              description: "画板 ID（从文档画板块或画板 URL 中获取）",
            },
            return_type: {
              type: "string",
              enum: ["url", "base64"],
              description: "返回类型：url（返回原始响应信息）或 base64（返回图片 base64 数据）",
              default: "base64",
            },
          },
          required: ["whiteboard_id"],
        },
      },
      {
        name: "feishu_get_board_nodes",
        description:
          "获取飞书画板中的所有节点。返回画板内所有图形、文本、连接线等节点的列表及其属性。",
        inputSchema: {
          type: "object",
          properties: {
            whiteboard_id: {
              type: "string",
              description: "画板 ID（从文档画板块或画板 URL 中获取）",
            },
            page_size: {
              type: "number",
              description: "分页大小，默认 500",
              default: 500,
            },
            page_token: {
              type: "string",
              description: "分页标记，用于获取下一页",
            },
          },
          required: ["whiteboard_id"],
        },
      },
      {
        name: "feishu_get_sheet_meta",
        description:
          "获取飞书电子表格中指定工作表的元信息（行数、列数等）。用于在读取数据前了解工作表的尺寸。sheet_id 可从文档 Sheet 块的 token 中解析（格式：spreadsheet_token_sheetId，下划线后的部分即为 sheet_id）。",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_token: {
              type: "string",
              description: "电子表格 token",
            },
            sheet_id: {
              type: "string",
              description: "工作表 ID",
            },
          },
          required: ["spreadsheet_token", "sheet_id"],
        },
      },
      {
        name: "feishu_read_spreadsheet_range",
        description:
          "读取飞书电子表格指定范围的单元格数据。返回二维数组形式的单元格值。支持三种用法：1) 传 range（格式 '{sheetId}!{startCell}:{endCell}'，如 'abc123!A1:Z100'）精确读取；2) 传 sheet_id 读取该工作表全部数据；3) 仅传 spreadsheet_token，自动读取第一个工作表的全部数据。",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_token: {
              type: "string",
              description: "电子表格 token",
            },
            range: {
              type: "string",
              description: "读取范围，格式：{sheetId}!{startCell}:{endCell}，例如 'abc123!A1:Z100'",
            },
            sheet_id: {
              type: "string",
              description: "工作表 ID（当不传 range 时使用，自动读取整个工作表）",
            },
          },
          required: ["spreadsheet_token"],
        },
      },
      {
        name: "feishu_create_document",
        description: "创建一个新的飞书文档，返回文档 ID 和链接。可指定标题和目标文件夹。",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "文档标题",
            },
            folder_token: {
              type: "string",
              description: "目标文件夹 token（可选，不传则创建在根目录）",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "feishu_append_blocks",
        description:
          "向飞书文档末尾追加内容块。支持：段落、标题(heading1-3)、代码块、无序列表、有序列表、分隔线、表格(table)、图片(image)、嵌入电子表格/多维表格/画板/思维导图(embed_sheet/embed_bitable/embed_board/embed_mindnote)。",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "string",
              description: "文档 ID",
            },
            blocks: {
              type: "array",
              description: "要追加的块列表",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "paragraph",
                      "heading1",
                      "heading2",
                      "heading3",
                      "bullet",
                      "ordered",
                      "code",
                      "divider",
                      "table",
                      "image",
                      "embed_sheet",
                      "embed_bitable",
                      "embed_board",
                      "embed_mindnote",
                    ],
                    description: "块类型",
                  },
                  text: {
                    type: "string",
                    description: "文本内容（divider/table/image/embed_* 不需要）",
                  },
                  language: {
                    type: "string",
                    description:
                      "代码语言（仅 code 类型，如 typescript、python、go、shell）",
                  },
                  rows: {
                    type: "array",
                    items: {
                      type: "array",
                      items: { type: "string" },
                    },
                    description: "表格行数据（table类型使用），二维数组，第一行为表头",
                  },
                  header_row: {
                    type: "boolean",
                    description: "是否启用表头行样式（table类型）",
                    default: true,
                  },
                  image_base64: {
                    type: "string",
                    description: "图片的base64编码数据（image类型）",
                  },
                  mime_type: {
                    type: "string",
                    description: "图片MIME类型，如 image/png, image/jpeg（image类型）",
                  },
                  file_name: {
                    type: "string",
                    description: "图片文件名（image类型，可选）",
                  },
                  token: {
                    type: "string",
                    description: "要嵌入的对象token（embed_*类型使用）",
                  },
                },
                required: ["type"],
              },
            },
          },
          required: ["document_id", "blocks"],
        },
      },
      {
        name: "feishu_create_spreadsheet",
        description: "创建一个新的飞书电子表格，返回 spreadsheet_token、标题和链接。",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "电子表格标题",
            },
            folder_token: {
              type: "string",
              description: "目标文件夹 token（可选，不传则创建在根目录）",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "feishu_write_spreadsheet",
        description: "向飞书电子表格写入二维数据。自动计算写入范围。",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_token: {
              type: "string",
              description: "电子表格 token",
            },
            rows: {
              type: "array",
              items: {
                type: "array",
                items: { type: "string" },
              },
              description: "要写入的二维数据，外层为行，内层为单元格值",
            },
            sheet_id: {
              type: "string",
              description: "工作表 ID（可选，不传则自动获取第一个工作表）",
            },
            start_cell: {
              type: "string",
              description: "起始单元格（可选，默认 A1）",
              default: "A1",
            },
          },
          required: ["spreadsheet_token", "rows"],
        },
      },
      {
        name: "feishu_create_bitable",
        description: "创建一个新的飞书多维表格，返回 app_token、名称和链接。",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "多维表格名称",
            },
            folder_token: {
              type: "string",
              description: "目标文件夹 token（可选）",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "feishu_create_bitable_table",
        description: "在飞书多维表格中创建数据表，并定义字段结构。",
        inputSchema: {
          type: "object",
          properties: {
            app_token: {
              type: "string",
              description: "多维表格 app_token",
            },
            table_name: {
              type: "string",
              description: "数据表名称",
            },
            fields: {
              type: "array",
              description: "字段列表",
              items: {
                type: "object",
                properties: {
                  field_name: {
                    type: "string",
                    description: "字段名称",
                  },
                  type: {
                    type: "number",
                    description: "字段类型（1=文本，2=数字，3=单选，4=多选，5=日期，7=复选框，默认1）",
                    default: 1,
                  },
                },
                required: ["field_name"],
              },
            },
          },
          required: ["app_token", "table_name", "fields"],
        },
      },
      {
        name: "feishu_write_bitable_records",
        description: "向飞书多维表格的数据表批量写入记录。",
        inputSchema: {
          type: "object",
          properties: {
            app_token: {
              type: "string",
              description: "多维表格 app_token",
            },
            table_id: {
              type: "string",
              description: "数据表 ID",
            },
            records: {
              type: "array",
              description: "要写入的记录列表，每条记录为字段名到值的映射",
              items: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
          required: ["app_token", "table_id", "records"],
        },
      },
      {
        name: "feishu_upload_image",
        description: "上传图片到飞书并返回 file_token（不插入文档）。file_token 可用于后续操作如插入图片块。",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "string",
              description: "关联的文档 ID（作为上传目标节点）",
            },
            image_base64: {
              type: "string",
              description: "图片的 base64 编码数据",
            },
            mime_type: {
              type: "string",
              description: "图片 MIME 类型，如 image/png, image/jpeg（可选，默认 image/png）",
            },
            file_name: {
              type: "string",
              description: "图片文件名（可选，默认 image.png）",
            },
          },
          required: ["document_id", "image_base64"],
        },
      },
    ];
  }

  /**
   * 获取文档的所有块
   */
  // Resolve a wiki node token to the underlying docx obj_token.
  // Returns the original token unchanged if it is not a wiki node.
  private async resolveWikiToken(token: string, accessToken: string): Promise<string> {
    try {
      const resp = await feishuHttp.get(
        `${FEISHU_BASE_URL}/wiki/v2/spaces/get_node`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { token },
        }
      );
      if (resp.data.code === 0 && resp.data.data?.node?.obj_token) {
        return resp.data.data.node.obj_token;
      }
    } catch {
      // Not a wiki node — use token as-is
    }
    return token;
  }

  private async getDocumentBlocks(args: any) {
    const { document_id, page_size = 500, page_token } = args;
    const accessToken = await this.getAccessToken();
    const resolvedId = await this.resolveWikiToken(document_id, accessToken);

    const params: any = { page_size };
    if (page_token) {
      params.page_token = page_token;
    }

    const response = await feishuHttp.get(
      `${FEISHU_BASE_URL}/docx/v1/documents/${resolvedId}/blocks`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params,
      }
    );

    if (response.data.code === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data.data, null, 2),
          },
        ],
      };
    } else {
      throw new Error(
        `获取文档块失败: ${response.data.msg || "未知错误"}`
      );
    }
  }

  /**
   * 获取云文档评论/批注
   *
   * 飞书评论 API 的 is_whole / is_solved 是「过滤器」（默认只返回 局部+未解决），
   * 不显式指定时遍历全部组合并按 comment_id 去重，避免漏评论。
   */
  private async getDocumentComments(args: any) {
    const {
      document_id,
      file_type = "docx",
      is_whole,
      is_solved,
      page_size = 100,
    } = args;
    const accessToken = await this.getAccessToken();
    const fileToken = await this.resolveWikiToken(document_id, accessToken);

    const wholeVals = is_whole === undefined ? [false, true] : [Boolean(is_whole)];
    const solvedVals =
      is_solved === undefined ? [false, true] : [Boolean(is_solved)];

    const seen = new Set<string>();
    const comments: any[] = [];

    for (const whole of wholeVals) {
      for (const solved of solvedVals) {
        let pageToken: string | undefined;
        do {
          const params: any = {
            file_type,
            is_whole: whole,
            is_solved: solved,
            page_size,
            user_id_type: "open_id",
          };
          if (pageToken) params.page_token = pageToken;

          const response = await feishuHttp.get(
            `${FEISHU_BASE_URL}/drive/v1/files/${fileToken}/comments`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
              params,
            }
          );

          if (response.data.code !== 0) {
            throw new Error(
              `获取文档评论失败: ${response.data.msg || "未知错误"} (code: ${response.data.code})`
            );
          }

          const items: any[] = response.data.data?.items ?? [];
          for (const item of items) {
            if (item.comment_id && !seen.has(item.comment_id)) {
              seen.add(item.comment_id);
              comments.push(item);
            }
          }

          pageToken = response.data.data?.has_more
            ? response.data.data?.page_token
            : undefined;
        } while (pageToken);
      }
    }

    // 简化输出：每条评论 = 锚定文字(quote) + 各回复纯文本，便于直接阅读
    const simplified = comments.map((c) => ({
      comment_id: c.comment_id,
      quote: c.quote ?? "",
      is_solved: c.is_solved ?? false,
      create_time: c.create_time,
      replies: (c.reply_list?.replies ?? []).map((r: any) => ({
        user_id: r.user_id,
        create_time: r.create_time,
        text: (r.content?.elements ?? [])
          .map((el: any) => {
            if (el.type === "text_run") return el.text_run?.text ?? "";
            if (el.type === "docs_link") return el.docs_link?.url ?? "";
            if (el.type === "person") return `@${el.person?.user_id ?? ""}`;
            return "";
          })
          .join(""),
      })),
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { total: simplified.length, comments: simplified },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * 获取指定块的子块
   */
  private async getBlockChildren(args: any) {
    const { document_id, block_id, page_size = 500, page_token } = args;
    const accessToken = await this.getAccessToken();

    const blockIdToUse = block_id || document_id;
    const params: any = { page_size };
    if (page_token) {
      params.page_token = page_token;
    }

    const response = await feishuHttp.get(
      `${FEISHU_BASE_URL}/docx/v1/documents/${document_id}/blocks/${blockIdToUse}/children`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params,
      }
    );

    if (response.data.code === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data.data, null, 2),
          },
        ],
      };
    } else {
      throw new Error(
        `获取子块失败: ${response.data.msg || "未知错误"}`
      );
    }
  }

  /**
   * 下载媒体文件
   */
  private async downloadMedia(args: any) {
    const { file_token, return_type = "url" } = args;
    const accessToken = await this.getAccessToken();

    if (return_type === "url") {
      // 获取临时下载链接（GET 请求，file_tokens 作为查询参数）
      const response = await feishuHttp.get(
        `${FEISHU_BASE_URL}/drive/v1/medias/batch_get_tmp_download_url`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            file_tokens: file_token,
          },
        }
      );

      if (response.data.code === 0) {
        const tmpUrls = response.data.data.tmp_download_urls;
        if (tmpUrls && tmpUrls.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    file_token: file_token,
                    download_url: tmpUrls[0].tmp_download_url,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          throw new Error("未能获取下载链接");
        }
      } else {
        throw new Error(
          `获取下载链接失败: ${response.data.msg || "未知错误"}`
        );
      }
    } else if (return_type === "base64") {
      // 直接下载文件内容
      const response = await feishuHttp.get(
        `${FEISHU_BASE_URL}/drive/v1/medias/${file_token}/download`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          responseType: "arraybuffer",
        }
      );

      const ctRaw = response.headers["content-type"];
      const contentType = typeof ctRaw === "string" ? ctRaw : "image/png";
      const base64 = Buffer.from(response.data).toString("base64");

      // 如果是图片类型，直接返回 MCP image 内容块，Claude 可以直接查看
      if (contentType.startsWith("image/")) {
        return {
          content: [
            {
              type: "text",
              text: `file_token: ${file_token}, content_type: ${contentType}`,
            },
            {
              type: "image",
              data: base64,
              mimeType: contentType,
            },
          ],
        };
      }

      // 非图片类型，返回 base64 文本
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_token: file_token,
                content_type: contentType,
                base64_content: base64,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(`不支持的返回类型: ${return_type}`);
    }
  }

  /**
   * 获取电子表格信息（含工作表列表）
   */
  private async getSpreadsheetInfo(args: any) {
    const { spreadsheet_token } = args;
    const accessToken = await this.getAccessToken();

    // 1. v3 API 获取基本信息
    const response = await feishuHttp.get(
      `${FEISHU_BASE_URL}/sheets/v3/spreadsheets/${spreadsheet_token}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (response.data.code !== 0) {
      throw new Error(
        `获取电子表格信息失败: ${response.data.msg || "未知错误"}`
      );
    }

    const result: any = { ...response.data.data };

    // 2. v2 metainfo API 获取工作表列表（sheetId、标题、行列数）
    const metaData = await this.fetchSheetsMeta(spreadsheet_token, accessToken);
    if (metaData && metaData.sheets) {
      result.sheets = metaData.sheets;
    } else {
      result._warning =
        "无法获取工作表列表（v2 metainfo 调用失败），仅返回基本信息";
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  /**
   * 获取工作表元信息（行数、列数等）
   */
  private async getSheetMeta(args: any) {
    const { spreadsheet_token, sheet_id } = args;
    const accessToken = await this.getAccessToken();

    const response = await feishuHttp.get(
      `${FEISHU_BASE_URL}/sheets/v3/spreadsheets/${spreadsheet_token}/sheets/${sheet_id}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (response.data.code === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data.data, null, 2),
          },
        ],
      };
    } else {
      throw new Error(
        `获取工作表元信息失败: ${response.data.msg || "未知错误"}`
      );
    }
  }

  /**
   * 读取电子表格指定范围的单元格数据
   */
  private async readSpreadsheetRange(args: any) {
    const { spreadsheet_token, range, sheet_id } = args;
    const accessToken = await this.getAccessToken();

    let actualRange = range;

    if (!actualRange) {
      // 确定目标工作表 ID
      let targetSheetId = sheet_id;

      // 如果 sheet_id 也没传，自动获取第一个工作表
      if (!targetSheetId) {
        const metaData = await this.fetchSheetsMeta(
          spreadsheet_token,
          accessToken
        );
        if (metaData && metaData.sheets && metaData.sheets.length > 0) {
          targetSheetId = metaData.sheets[0].sheetId;
          console.error(
            `[readSpreadsheetRange] 未指定 sheet_id，自动使用第一个工作表: "${metaData.sheets[0].title}" (${targetSheetId})`
          );
        } else {
          throw new Error(
            "未提供 range 或 sheet_id，且无法自动获取工作表列表。请先调用 feishu_get_spreadsheet_info 获取 sheet_id。"
          );
        }
      }

      // 获取工作表尺寸，拼接完整 range
      const metaResponse = await feishuHttp.get(
        `${FEISHU_BASE_URL}/sheets/v3/spreadsheets/${spreadsheet_token}/sheets/${targetSheetId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (metaResponse.data.code === 0) {
        const grid = metaResponse.data.data?.sheet?.grid_properties;
        if (grid) {
          const maxCol = grid.column_count || 26;
          const maxRow = grid.row_count || 1000;
          actualRange = `${targetSheetId}!A1:${this.colToLetter(maxCol)}${maxRow}`;
        } else {
          actualRange = `${targetSheetId}`;
        }
      } else {
        actualRange = `${targetSheetId}`;
      }
    }

    const response = await feishuHttp.get(
      `${FEISHU_BASE_URL}/sheets/v2/spreadsheets/${spreadsheet_token}/values/${actualRange}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          valueRenderOption: "ToString",
        },
      }
    );

    if (response.data.code === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data.data, null, 2),
          },
        ],
      };
    } else {
      throw new Error(
        `读取电子表格数据失败: ${response.data.msg || "未知错误"}`
      );
    }
  }

  /**
   * 获取画板主题
   */
  private async getBoardTheme(args: any) {
    const { whiteboard_id } = args;
    const accessToken = await this.getAccessToken();

    const response = await feishuHttp.get(
      `${FEISHU_BASE_URL}/board/v1/whiteboards/${whiteboard_id}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (response.data.code === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data.data, null, 2),
          },
        ],
      };
    } else {
      throw new Error(
        `获取画板主题失败: ${response.data.msg || "未知错误"}`
      );
    }
  }

  /**
   * 获取画板缩略图（导出为图片）
   */
  private async getBoardThumbnail(args: any) {
    const { whiteboard_id, return_type = "base64" } = args;
    const accessToken = await this.getAccessToken();

    const response = await feishuHttp.get(
      `${FEISHU_BASE_URL}/board/v1/whiteboards/${whiteboard_id}/download_as_image`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        responseType: "arraybuffer",
      }
    );

    const ctRaw = response.headers["content-type"];
    const contentType = typeof ctRaw === "string" ? ctRaw : "image/png";

    if (return_type === "base64" && contentType.startsWith("image/")) {
      const base64 = Buffer.from(response.data).toString("base64");
      return {
        content: [
          {
            type: "text",
            text: `whiteboard_id: ${whiteboard_id}, content_type: ${contentType}`,
          },
          {
            type: "image",
            data: base64,
            mimeType: contentType,
          },
        ],
      };
    }

    // 非图片响应（可能是 JSON 错误），尝试解析
    const textContent = Buffer.from(response.data).toString("utf8");
    try {
      const jsonData = JSON.parse(textContent);
      if (jsonData.code !== undefined && jsonData.code !== 0) {
        throw new Error(
          `获取画板缩略图失败: ${jsonData.msg || "未知错误"}`
        );
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(jsonData, null, 2),
          },
        ],
      };
    } catch {
      // 返回原始 base64 数据
      const base64 = Buffer.from(response.data).toString("base64");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                whiteboard_id,
                content_type: contentType,
                base64_length: base64.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  /**
   * 获取画板所有节点
   */
  private async getBoardNodes(args: any) {
    const { whiteboard_id, page_size = 500, page_token } = args;
    const accessToken = await this.getAccessToken();

    const params: any = { page_size };
    if (page_token) {
      params.page_token = page_token;
    }

    const response = await feishuHttp.get(
      `${FEISHU_BASE_URL}/board/v1/whiteboards/${whiteboard_id}/nodes`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params,
      }
    );

    if (response.data.code === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data.data, null, 2),
          },
        ],
      };
    } else {
      throw new Error(
        `获取画板节点失败: ${response.data.msg || "未知错误"}`
      );
    }
  }

  private async createDocument(args: any) {
    const { title, folder_token } = args;
    const accessToken = await this.getAccessToken();

    const body: any = { title };
    if (folder_token) body.folder_token = folder_token;

    const response = await feishuHttp.post(
      `${FEISHU_BASE_URL}/docx/v1/documents`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.code === 0) {
      const doc = response.data.data.document;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                document_id: doc.document_id,
                title: doc.title,
                url: `https://feishu.cn/docx/${doc.document_id}`,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(`创建文档失败: ${response.data.msg || "未知错误"} (code: ${response.data.code})`);
    }
  }

  /**
   * 创建表格块（多步骤）
   * 1. POST 创建 table block（block_type 31）
   * 2. 从响应中提取 cell block IDs
   * 3. 逐个 cell 写入文本内容
   */
  private async createTableBlock(
    documentId: string,
    rows: string[][],
    _headerRow: boolean,
    accessToken: string
  ): Promise<void> {
    const rowCount = rows.length;
    const colCount = rows[0]?.length ?? 1;

    // Step 1: 创建表格块
    const createResp = await feishuHttp.post(
      `${FEISHU_BASE_URL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      {
        children: [
          {
            block_type: 31,
            table: {
              property: {
                row_size: rowCount,
                column_size: colCount,
              },
            },
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (createResp.data.code !== 0) {
      throw new Error(
        `创建表格块失败: ${createResp.data.msg || "未知错误"} (code: ${createResp.data.code})`
      );
    }

    // Step 2: 提取 cell block IDs
    // API 自动创建 R×C 空 table_cell 块，从 children[0].table.cells 获取
    const createdBlocks = createResp.data.data?.children;
    if (!createdBlocks || createdBlocks.length === 0) {
      console.error("[createTableBlock] 无法获取创建的表格块信息，跳过填充");
      return;
    }

    const tableBlock = createdBlocks[0];
    const cells: string[] = tableBlock?.table?.cells ?? [];

    if (cells.length === 0) {
      console.error("[createTableBlock] 未获取到 cell IDs，跳过填充");
      return;
    }

    // Step 3: 逐个填充非空 cell
    let cellIndex = 0;
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        const cellId = cells[cellIndex++];
        const text = rows[r]?.[c] ?? "";
        if (cellId && text.trim() !== "") {
          await feishuHttp.post(
            `${FEISHU_BASE_URL}/docx/v1/documents/${documentId}/blocks/${cellId}/children`,
            {
              children: [
                {
                  block_type: 2,
                  text: {
                    elements: [{ text_run: { content: text } }],
                    style: {},
                  },
                },
              ],
            },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            }
          );
        }
      }
    }
  }

  /**
   * 上传图片并插入图片块（多步骤）
   * 1. multipart POST 上传图片到 /drive/v1/medias/upload_all
   * 2. 获取 file_token
   * 3. POST 插入图片块（block_type 27）
   */
  private async uploadAndInsertImage(
    documentId: string,
    imageBase64: string,
    mimeType: string | undefined,
    fileName: string | undefined,
    accessToken: string
  ): Promise<void> {
    const actualMimeType = mimeType || "image/png";
    const actualFileName = fileName || "image.png";
    const imageBuffer = Buffer.from(imageBase64, "base64");
    const fileSize = imageBuffer.length;

    // Step 1: 上传图片
    const boundary = `----FormBoundary${crypto.randomBytes(16).toString("hex")}`;

    // 手动构建 multipart/form-data
    const parts: Buffer[] = [];
    const addField = (name: string, value: string) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        )
      );
    };

    addField("file_name", actualFileName);
    addField("parent_type", "docx_image");
    addField("parent_node", documentId);
    addField("size", String(fileSize));

    // 文件 part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${actualFileName}"\r\nContent-Type: ${actualMimeType}\r\n\r\n`
      )
    );
    parts.push(imageBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const formData = Buffer.concat(parts);

    const uploadResp = await feishuHttp.post(
      `${FEISHU_BASE_URL}/drive/v1/medias/upload_all`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(formData.length),
        },
      }
    );

    if (uploadResp.data.code !== 0) {
      throw new Error(
        `上传图片失败: ${uploadResp.data.msg || "未知错误"} (code: ${uploadResp.data.code})`
      );
    }

    const fileToken = uploadResp.data.data?.file_token;
    if (!fileToken) {
      throw new Error("上传图片成功但未获取到 file_token");
    }

    // Step 2: 插入图片块
    const insertResp = await feishuHttp.post(
      `${FEISHU_BASE_URL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      {
        children: [
          {
            block_type: 27,
            image: { token: fileToken },
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (insertResp.data.code !== 0) {
      throw new Error(
        `插入图片块失败: ${insertResp.data.msg || "未知错误"} (code: ${insertResp.data.code})`
      );
    }
  }

  /**
   * 追加单个简单块（段落、标题、代码、分隔线、嵌入等）
   */
  private async appendSingleSimpleBlock(
    documentId: string,
    blockDef: any,
    accessToken: string
  ): Promise<void> {
    const BLOCK_TYPE: Record<string, number> = {
      paragraph: 2,
      heading1: 3, heading2: 4, heading3: 5,
      heading4: 6, heading5: 7, heading6: 8,
      bullet: 12, ordered: 13, code: 14, divider: 22,
      embed_sheet: 30, embed_bitable: 15, embed_board: 43, embed_mindnote: 29,
    };

    const LANG_CODE: Record<string, number> = {
      plaintext: 1, c: 10, cpp: 11, csharp: 12, css: 13, go: 22,
      html: 26, java: 28, javascript: 29, json: 30, kotlin: 31,
      python: 49, ruby: 54, rust: 55, shell: 56, sql: 57,
      swift: 60, typescript: 61, xml: 66, yaml: 67,
    };

    const EMBED_FIELD: Record<string, string> = {
      embed_sheet: "sheet",
      embed_bitable: "bitable",
      embed_board: "board",
      embed_mindnote: "mindnote",
    };

    let feishuBlock: any;
    const blockType = BLOCK_TYPE[blockDef.type] ?? 2;

    if (blockDef.type === "divider") {
      feishuBlock = { block_type: blockType, divider: {} };
    } else if (blockDef.type === "code") {
      const langKey = (blockDef.language ?? "plaintext").toLowerCase();
      feishuBlock = {
        block_type: blockType,
        code: {
          elements: [{ text_run: { content: blockDef.text ?? "" } }],
          style: { language: LANG_CODE[langKey] ?? 1, wrap: false },
        },
      };
    } else if (blockDef.type.startsWith("embed_")) {
      const fieldName = EMBED_FIELD[blockDef.type];
      feishuBlock = {
        block_type: blockType,
        [fieldName]: { token: blockDef.token ?? "" },
      };
    } else {
      // paragraph, heading1-3, bullet, ordered
      const fieldName = blockDef.type === "paragraph" ? "text" : blockDef.type;
      feishuBlock = {
        block_type: blockType,
        [fieldName]: {
          elements: [
            { text_run: { content: blockDef.text ?? "", text_element_style: {} } },
          ],
          style: {},
        },
      };
    }

    const response = await feishuHttp.post(
      `${FEISHU_BASE_URL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      { children: [feishuBlock] },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.code !== 0) {
      throw new Error(
        `追加块失败 (type=${blockDef.type}): ${response.data.msg || "未知错误"} (code: ${response.data.code})`
      );
    }
  }

  private async appendBlocks(args: any) {
    const { document_id, blocks } = args;
    const accessToken = await this.getAccessToken();

    let successCount = 0;

    for (const b of blocks as any[]) {
      if (b.type === "table") {
        const rows: string[][] = b.rows ?? [[""]];
        const headerRow: boolean = b.header_row !== false;
        await this.createTableBlock(document_id, rows, headerRow, accessToken);
        successCount++;
      } else if (b.type === "image") {
        await this.uploadAndInsertImage(
          document_id,
          b.image_base64 ?? "",
          b.mime_type,
          b.file_name,
          accessToken
        );
        successCount++;
      } else {
        await this.appendSingleSimpleBlock(document_id, b, accessToken);
        successCount++;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `成功追加 ${successCount} 个块到文档 ${document_id}`,
        },
      ],
    };
  }

  /**
   * 创建电子表格
   */
  private async createSpreadsheet(args: any) {
    const { title, folder_token } = args;
    const accessToken = await this.getAccessToken();

    const body: any = { title };
    if (folder_token) body.folder_token = folder_token;

    const response = await feishuHttp.post(
      `${FEISHU_BASE_URL}/sheets/v3/spreadsheets`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.code === 0) {
      const ss = response.data.data?.spreadsheet;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                spreadsheet_token: ss?.spreadsheet_token,
                title: ss?.title,
                url: ss?.url,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(
        `创建电子表格失败: ${response.data.msg || "未知错误"} (code: ${response.data.code})`
      );
    }
  }

  /**
   * 向电子表格写入数据
   */
  private async writeSpreadsheet(args: any) {
    const { spreadsheet_token, rows, sheet_id, start_cell = "A1" } = args;
    const accessToken = await this.getAccessToken();

    // 确定 sheet_id
    let targetSheetId = sheet_id;
    if (!targetSheetId) {
      const metaData = await this.fetchSheetsMeta(spreadsheet_token, accessToken);
      if (metaData && metaData.sheets && metaData.sheets.length > 0) {
        targetSheetId = metaData.sheets[0].sheetId;
      } else {
        throw new Error("无法获取工作表列表，请指定 sheet_id");
      }
    }

    const rowCount = (rows as string[][]).length;
    const colCount = Math.max(...(rows as string[][]).map((r: string[]) => r.length));

    // 计算结束单元格
    const startCol = start_cell.replace(/[0-9]/g, "");
    const startRow = parseInt(start_cell.replace(/[A-Z]/gi, ""), 10) || 1;
    const startColNum = startCol.split("").reduce((acc: number, ch: string) => {
      return acc * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
    }, 0);
    const endColLetter = this.colToLetter(startColNum + colCount - 1);
    const endRow = startRow + rowCount - 1;
    const rangeStr = `${targetSheetId}!${start_cell}:${endColLetter}${endRow}`;

    const response = await feishuHttp.put(
      `${FEISHU_BASE_URL}/sheets/v2/spreadsheets/${spreadsheet_token}/values`,
      {
        valueRange: {
          range: rangeStr,
          values: rows,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.code === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                updated_range: rangeStr,
                updated_rows: rowCount,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(
        `写入电子表格失败: ${response.data.msg || "未知错误"} (code: ${response.data.code})`
      );
    }
  }

  /**
   * 创建多维表格
   */
  private async createBitable(args: any) {
    const { name, folder_token } = args;
    const accessToken = await this.getAccessToken();

    const body: any = { name };
    if (folder_token) body.folder_token = folder_token;

    const response = await feishuHttp.post(
      `${FEISHU_BASE_URL}/bitable/v1/apps`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.code === 0) {
      const app = response.data.data?.app;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                app_token: app?.app_token,
                name: app?.name,
                url: `https://feishu.cn/base/${app?.app_token}`,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(
        `创建多维表格失败: ${response.data.msg || "未知错误"} (code: ${response.data.code})`
      );
    }
  }

  /**
   * 在多维表格中创建数据表
   */
  private async createBitableTable(args: any) {
    const { app_token, table_name, fields } = args;
    const accessToken = await this.getAccessToken();

    const tableFields = (fields as Array<{ field_name: string; type?: number }>).map((f) => ({
      field_name: f.field_name,
      type: f.type ?? 1,
    }));

    const response = await feishuHttp.post(
      `${FEISHU_BASE_URL}/bitable/v1/apps/${app_token}/tables`,
      {
        table: {
          name: table_name,
          fields: tableFields,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.code === 0) {
      const table = response.data.data?.table_id
        ? response.data.data
        : response.data.data?.table;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                table_id: response.data.data?.table_id,
                name: table_name,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(
        `创建数据表失败: ${response.data.msg || "未知错误"} (code: ${response.data.code})`
      );
    }
  }

  /**
   * 批量写入多维表格记录
   */
  private async writeBitableRecords(args: any) {
    const { app_token, table_id, records } = args;
    const accessToken = await this.getAccessToken();

    const feishuRecords = (records as Array<Record<string, any>>).map((r) => ({
      fields: r,
    }));

    const response = await feishuHttp.post(
      `${FEISHU_BASE_URL}/bitable/v1/apps/${app_token}/tables/${table_id}/records/batch_create`,
      { records: feishuRecords },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.code === 0) {
      const createdRecords = response.data.data?.records ?? [];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { created_count: createdRecords.length },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(
        `写入记录失败: ${response.data.msg || "未知错误"} (code: ${response.data.code})`
      );
    }
  }

  /**
   * 上传图片并返回 file_token（不插入文档）
   */
  private async uploadImage(args: any) {
    const { document_id, image_base64, mime_type, file_name } = args;
    const accessToken = await this.getAccessToken();

    const actualMimeType = mime_type || "image/png";
    const actualFileName = file_name || "image.png";
    const imageBuffer = Buffer.from(image_base64, "base64");
    const fileSize = imageBuffer.length;

    const boundary = `----FormBoundary${crypto.randomBytes(16).toString("hex")}`;

    const parts: Buffer[] = [];
    const addField = (name: string, value: string) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        )
      );
    };

    addField("file_name", actualFileName);
    addField("parent_type", "docx_image");
    addField("parent_node", document_id);
    addField("size", String(fileSize));

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${actualFileName}"\r\nContent-Type: ${actualMimeType}\r\n\r\n`
      )
    );
    parts.push(imageBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const formData = Buffer.concat(parts);

    const uploadResp = await feishuHttp.post(
      `${FEISHU_BASE_URL}/drive/v1/medias/upload_all`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(formData.length),
        },
      }
    );

    if (uploadResp.data.code !== 0) {
      throw new Error(
        `上传图片失败: ${uploadResp.data.msg || "未知错误"} (code: ${uploadResp.data.code})`
      );
    }

    const fileToken = uploadResp.data.data?.file_token;
    if (!fileToken) {
      throw new Error("上传图片成功但未获取到 file_token");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ file_token: fileToken }, null, 2),
        },
      ],
    };
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Feishu Blocks MCP Server v1.3.0 started");
    console.error(
      "认证优先级: env(USER_ACCESS_TOKEN) → lark-mcp存储 → tenant_access_token"
    );
  }
}

// 启动服务器
const server = new FeishuBlocksMCPServer();
server.start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
