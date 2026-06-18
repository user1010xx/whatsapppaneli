import { escapeHtml, normalizeSearchQuery } from '../helpers-module.js';

export const state = {
  me: null,
  departments: [],
  users: [],
  templates: [],
  accounts: [],
  conversations: [],
  selectedChatAccountId: '',
  selectedPersonnelId: null,
  personnelMessages: [],
  currentConversation: null,
  messages: [],
  lastMessageIds: new Set(),
  userSearchQuery: '',
  staffAuditSearchQuery: '',
  staffAuditDate: null,
  staffOpsDate: null,
  templateContactSearch: '',
  auditLogs: [],
  auditLogSearchQuery: '',
  auditLogActionFilter: '',
  auditLogEntityFilter: '',
  auditLogDateFrom: '',
  auditLogDateTo: '',
  auditLogSortKey: 'createdAt',
  auditLogSortDir: 'desc'
};

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'İşlem başarısız');
  return data;
}

function flash(message) {
  $('#status').textContent = message;
  setTimeout(() => {
    if ($('#status').textContent === message) $('#status').textContent = '';
  }, 3500);
}

function flashError(error) {
  const message = error?.message || 'İşlem başarısız';
  $('#status').textContent = message;
  $('#status').style.color = '#dc2626';
  setTimeout(() => {
    if ($('#status').textContent === message) {
      $('#status').textContent = '';
      $('#status').style.color = '';
    }
  }, 5000);
}

function roleName(role) {
  return {
    admin: 'Admin',
    manager: 'Yönetici',
    auditor: 'Denetçi',
    staff: 'Personel'
  }[role] || role;
}

function departmentName(id) {
  return state.departments.find((department) => department.id === id)?.name || '-';
}

function safeDepartmentName(id) {
  return escapeHtml(departmentName(id));
}

function userName(id) {
  if (!id) return '';
  if (state.me && state.me.id === id) return state.me.fullName;
  return state.users.find((user) => user.id === id)?.fullName || 'Personel';
}


export {
  api,
  flash,
  flashError,
  roleName,
  departmentName,
  safeDepartmentName,
  userName,
  escapeHtml,
  normalizeSearchQuery
};
