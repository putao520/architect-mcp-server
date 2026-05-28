/**
 * SPEC CRUD MCP 工具注册 — HTML 结构化元素确定性读写
 */

import { z } from 'zod';
import { executeCrud } from './engine.mjs';
import * as reqHandler from './req.mjs';
import * as entityHandler from './entity.mjs';
import * as apiHandler from './api.mjs';
import * as testHandler from './test.mjs';
import * as smHandler from './sm.mjs';
import * as algorithmHandler from './algorithm.mjs';
import * as pipelineHandler from './pipeline.mjs';
import * as integrationHandler from './integration.mjs';
import * as timingHandler from './timing.mjs';
import * as nfrHandler from './nfr.mjs';
import * as xrefHandler from './xref.mjs';
import * as criterionHandler from './criterion.mjs';
import * as artifactHandler from './artifact.mjs';

const HANDLERS = {
  req: reqHandler,
  entity: entityHandler,
  api: apiHandler,
  test: testHandler,
  sm: smHandler,
  algorithm: algorithmHandler,
  pipeline: pipelineHandler,
  integration: integrationHandler,
  timing: timingHandler,
  nfr: nfrHandler,
  xref: xrefHandler,
  criterion: criterionHandler,
  artifact: artifactHandler,
};

export function registerCrudTools(server) {
  server.tool(
    'spec_crud',
    `SPEC 结构化元素 CRUD：确定性引擎，AI 只传 JSON 参数，自动维护 xref 双向关联 + 写入验证。
create=创建 | read=读取 | update=更新 | delete=删除 | list=列表
type: req | entity | api | test | sm | algorithm | pipeline | integration | timing | nfr | xref | criterion | artifact`,
    {
      action: z.enum(['create', 'read', 'update', 'delete', 'list']).describe('操作类型'),
      type: z.enum(['req', 'entity', 'api', 'test', 'sm', 'algorithm', 'pipeline', 'integration', 'timing', 'nfr', 'xref', 'criterion', 'artifact']).describe('元素类型'),
      dir: z.string().describe('SPEC 目录路径'),
      file: z.string().optional().describe('目标文件名（如 02-SYSTEM），不传则自动路由'),
      id: z.string().optional().describe('目标元素 ID（read/update/delete）'),
      data: z.any().optional().describe('创建/更新的语义数据（JSON 对象）'),
      cascade: z.boolean().default(false).describe('[delete] 是否级联删除关联元素'),
    },
    async (args) => {
      try {
        const result = await executeCrud(args, HANDLERS);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `CRUD ERROR: ${err.message}` }], isError: true };
      }
    },
  );
}
