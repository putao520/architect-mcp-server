const ARTIFACT_DEFS = [
  { id: 'D1',  selector: '#artifact-function-module-tree', file: '01-BUSINESS', name: '功能模块树' },
  { id: 'D2',  selector: '#artifact-use-case-diagram', file: '01-BUSINESS', name: '用例图' },
  { id: 'D3',  selector: '#artifact-metrics-dimension', file: '01-BUSINESS', name: '指标维度表' },
  { id: 'D4',  selector: '#artifact-runtime-state', file: '02-SYSTEM', name: '运行时状态图' },
  { id: 'D5',  selector: '#artifact-interface-protocol', file: '02-SYSTEM', name: '接口协议图' },
  { id: 'D6',  selector: '#artifact-event-catalog', file: '02-SYSTEM', name: '事件/消息目录' },
  { id: 'D7',  selector: '#artifact-error-strategy', file: '02-SYSTEM', name: '错误处理策略' },
  { id: 'D8',  selector: '#artifact-dependency-matrix', file: '02-SYSTEM', name: '外部依赖矩阵' },
  { id: 'D9',  attr: 'data-state-machine', file: '03-PROCESS', name: '状态机图' },
  { id: 'D10', selector: '#artifact-model-tree', file: '04-DATA-MODEL', name: '模型树' },
  { id: 'D11', selector: '#artifact-cache-index-strategy', file: '04-DATA-MODEL', name: '缓存/索引策略' },
  { id: 'D12', selector: '#artifact-env-config-matrix', file: '05-DEPLOYMENT', name: '环境配置矩阵' },
  { id: 'D13', selector: '#artifact-permission-matrix', file: '06-SECURITY', name: '权限矩阵' },
  { id: 'D14', selector: '#artifact-data-classification', file: '06-SECURITY', name: '数据分类分级' },
  { id: 'D15', selector: '#artifact-observability', file: '07-OPERATIONS', name: '可观测性设计' },
  { id: 'D16', selector: '#artifact-route-tree', file: '08-PAGES', name: '路由树' },
  { id: 'D17', selector: '#artifact-component-tree', file: '08-PAGES', name: '组件树' },
  { id: 'D18', selector: '#artifact-mock-strategy', file: '11-TESTING', name: 'Mock 策略' },
  { id: 'D23', selector: '#artifact-ux-interaction-patterns', file: '08-PAGES', name: 'UX 交互模式表' },
  { id: 'D24', selector: '#artifact-ui-source-mapping', file: '08-PAGES', name: 'UI 组件来源映射' },
  { id: 'D25', selector: '#artifact-state-semantic-dict', file: '13-UX-DESIGN', name: '状态语义字典' },
  { id: 'D26', selector: '#artifact-interaction-patterns', file: '13-UX-DESIGN', name: '交互模式库' },
  { id: 'D27', selector: '#artifact-info-architecture', file: '13-UX-DESIGN', name: '信息架构图' },
  { id: 'D28', selector: '#artifact-design-tokens', file: '13-UX-DESIGN', name: 'Design Tokens' },
  { id: 'D29', selector: '#artifact-user-journey', file: '13-UX-DESIGN', name: '用户旅程图' },
  { id: 'D30', selector: '#artifact-usability-framework', file: '13-UX-DESIGN', name: '可用性评估框架' },
  { id: 'D31', selector: null, file: '00-INDEX', name: '自维护目录' },
  { id: 'D32', selector: '#artifact-algorithm-index', file: '12-ALGORITHMS', name: '算法索引' },
  { id: 'D33', attr: 'data-algorithm', file: '12-ALGORITHMS', name: '算法定义' },
  { id: 'D34', attr: 'data-timing', file: '03-PROCESS', name: '时序约束' },
  { id: 'D35', attr: 'data-pipeline', file: '02-SYSTEM', name: '数据管道' },
  { id: 'D36', attr: 'external-integration', file: '02-SYSTEM', name: '外部集成' },
  { id: 'D37', attr: 'non-functional-requirements', file: '02-SYSTEM', name: '非功能需求' },
  { id: 'D38', attr: 'sla', file: '02-SYSTEM', name: 'SLA 矩阵' },
  { id: 'D39', selector: '#artifact-compliance-checklist', file: '06-SECURITY', name: '合规检查清单' },
];

export function validateCompleteness(index) {
  const errors = [];
  const warnings = [];

  for (const def of ARTIFACT_DEFS) {
    if (def.id === 'D31') {
      if (!index.fileMap.has('00-INDEX')) {
        errors.push({ file: '00-INDEX', message: `D31 ${def.name} missing` });
      }
      continue;
    }

    const doc = index.fileMap.get(def.file);
    if (!doc) continue;

    let found = false;
    if (def.attr) {
      found = doc.artifacts.some(a => a.type === def.attr) || doc.stateMachines.length > 0;
      // Also check children subfiles if not found in parent
      if (!found && index.childrenMap) {
        const children = index.childrenMap.get(def.file) || [];
        for (const childName of children) {
          const childDoc = index.fileMap.get(childName);
          if (childDoc && (childDoc.artifacts.some(a => a.type === def.attr) || childDoc.stateMachines.length > 0)) {
            found = true;
            break;
          }
        }
      }
    } else if (def.selector) {
      found = doc.artifacts.some(a => a.id === def.selector.replace('#', ''));
      if (!found && index.childrenMap) {
        const children = index.childrenMap.get(def.file) || [];
        for (const childName of children) {
          const childDoc = index.fileMap.get(childName);
          if (childDoc && childDoc.artifacts.some(a => a.id === def.selector.replace('#', ''))) {
            found = true;
            break;
          }
        }
      }
    }

    if (!found) {
      if (['01-BUSINESS', '02-SYSTEM', '03-PROCESS', '04-DATA-MODEL', '00-INDEX'].includes(def.file)) {
        errors.push({ file: def.file, message: `${def.id} ${def.name} missing` });
      } else {
        warnings.push({ file: def.file, message: `${def.id} ${def.name} not found` });
      }
    }
  }

  if (index.childrenMap) {
    for (const [parent, children] of index.childrenMap.entries()) {
      for (const child of children) {
        if (!index.fileMap.has(child)) {
          errors.push({ file: parent, message: `Declared child not found: ${child}` });
        }
      }
    }
  }

  return { errors, warnings };
}