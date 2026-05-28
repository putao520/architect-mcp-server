const FILE_CATEGORIES = {
  '00-INDEX': 'index',
  '01-BUSINESS': '4+1-scenario',
  '02-SYSTEM': '4+1-logic',
  '03-PROCESS': '4+1-process',
  '04-DATA-MODEL': '4+1-develop',
  '05-DEPLOYMENT': '4+1-physical',
  '06-SECURITY': 'security',
  '07-OPERATIONS': 'operations',
  '08-PAGES': 'pages',
  '09-ADMIN-CRUD': 'admin-crud',
  '10-REQUIREMENTS': 'requirements',
  '11-TESTING': 'testing',
  '12-ALGORITHMS': 'algorithms',
  '13-UX-DESIGN': 'ux-design',
};

const FILE_TITLES = {
  '00-INDEX': 'SPEC 目录索引',
  '01-BUSINESS': '场景视图：业务架构',
  '02-SYSTEM': '逻辑视图：系统架构',
  '03-PROCESS': '过程视图：核心流程',
  '04-DATA-MODEL': '开发视图：数据模型',
  '05-DEPLOYMENT': '物理视图：部署架构',
  '06-SECURITY': '安全设计',
  '07-OPERATIONS': '运维设计',
  '08-PAGES': '页面设计',
  '09-ADMIN-CRUD': 'Admin CRUD 映射',
  '10-REQUIREMENTS': '需求索引',
  '11-TESTING': '测试策略',
  '12-ALGORITHMS': '算法设计',
  '13-UX-DESIGN': 'UX 设计',
};

const FILE_DEPENDENCIES = {
  '02-SYSTEM': ['01-BUSINESS'],
  '03-PROCESS': ['01-BUSINESS', '02-SYSTEM'],
  '04-DATA-MODEL': ['01-BUSINESS', '02-SYSTEM'],
  '05-DEPLOYMENT': ['02-SYSTEM'],
  '06-SECURITY': ['02-SYSTEM', '04-DATA-MODEL'],
  '07-OPERATIONS': ['02-SYSTEM', '05-DEPLOYMENT'],
  '08-PAGES': ['01-BUSINESS', '04-DATA-MODEL'],
  '09-ADMIN-CRUD': ['04-DATA-MODEL', '08-PAGES'],
  '10-REQUIREMENTS': [],
  '11-TESTING': ['10-REQUIREMENTS'],
  '12-ALGORITHMS': ['02-SYSTEM', '04-DATA-MODEL'],
  '13-UX-DESIGN': ['08-PAGES'],
};

const CATEGORY_LABELS = {
  '4+1-scenario': '场景视图',
  '4+1-logic': '逻辑视图',
  '4+1-process': '过程视图',
  '4+1-develop': '开发视图',
  '4+1-physical': '物理视图',
  'security': '安全设计',
  'operations': '运维监控',
  'pages': '页面设计',
  'admin-crud': 'Admin CRUD',
  'admin': 'Admin CRUD',
  'requirements': '需求列表',
  'testing': '测试策略',
  'algorithms': '核心算法',
  'ux-design': 'UX 设计',
  'ux': 'UX 设计',
  'index': '目录索引',
};

export function inferCategory(fileName) {
  for (const [prefix, cat] of Object.entries(FILE_CATEGORIES)) {
    if (fileName === prefix || fileName.startsWith(prefix + '.')) return cat;
  }
  return 'other';
}

export function inferTitle(fileName) {
  for (const [prefix, title] of Object.entries(FILE_TITLES)) {
    if (fileName === prefix) return title;
    if (fileName.startsWith(prefix + '.')) return title + '（子文件）';
  }
  return fileName;
}

export function inferDependencies(fileName) {
  const base = fileName.includes('.') ? fileName.split('.')[0] + '-' + fileName.split('.')[1]?.split('-').slice(1).join('-') : fileName;
  return FILE_DEPENDENCIES[base] || FILE_DEPENDENCIES[fileName] || [];
}

export { FILE_CATEGORIES, FILE_TITLES, FILE_DEPENDENCIES, CATEGORY_LABELS };
