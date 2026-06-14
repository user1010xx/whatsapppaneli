const state = {
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
  lastMessageIds: new Set()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

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

async function handleFormSubmit(event, action, successMessage) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"], button:not([type])');
  try {
    if (submitButton) submitButton.disabled = true;
    await action(form);
    form.reset();
    await refreshAll();
    flash(successMessage);
  } catch (error) {
    flashError(error);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
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

async function refreshAll() {
  const [departments, users, templates, accounts, conversations, reports] = await Promise.all([
    api('/api/departments'),
    api('/api/users'),
    api('/api/templates'),
    api('/api/accounts'),
    api('/api/conversations'),
    api('/api/reports')
  ]);
  state.departments = departments.departments;
  state.users = users.users;
  state.templates = templates.templates;
  state.accounts = accounts.accounts;
  state.conversations = conversations.conversations;
  state.lastMessageIds = new Set(
    state.conversations
      .map((conversation) => conversation.lastMessage?.id)
      .filter(Boolean)
  );
  renderDepartments();
  renderUsers();
  renderPersonnel();
  renderTemplates();
  renderAccounts();
  renderConversations();
  renderReports(reports.reports);
  fillSelects();
}

async function bootstrap() {
  try {
    const me = await api('/api/me');
    state.me = me.user;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#me').textContent = `${state.me.fullName} · ${roleName(state.me.role)} · ${departmentName(state.me.departmentId)}`;
    applyRoleNavigation();
    await refreshAll();
    connectEvents();
  } catch {
    $('#login').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }
}

function applyRoleNavigation() {
  const staffOnlyHiddenViews = ['chat', 'personnel', 'users', 'departments'];
  if (state.me.role === 'staff') {
    staffOnlyHiddenViews.forEach((view) => {
      const button = document.querySelector(`nav button[data-view="${view}"]`);
      if (button) button.classList.add('hidden');
    });
    $('#staffAccountsMenu').classList.remove('hidden');
  } else {
    $('#staffAccountsMenu').classList.add('hidden');
  }
}

function connectEvents() {
  if (state.eventsConnected) return;
  state.eventsConnected = true;
  const events = new EventSource('/api/events');
  events.addEventListener('message.created', async () => {
    const previousMessageIds = new Set(state.lastMessageIds);
    await refreshAll();
    const newIncoming = state.conversations
      .map((conversation) => conversation.lastMessage)
      .filter((message) => message && message.direction === 'in' && !previousMessageIds.has(message.id));
    if (newIncoming.length > 0) {
      $('#notifySound').play().catch(() => {});
      if (Notification.permission === 'granted') new Notification('Yeni WhatsApp mesajı', { body: 'Yeni müşteri mesajı geldi' });
    }
    if (state.currentConversation) await loadMessages(state.currentConversation.id);
  });
  events.addEventListener('account.updated', refreshAll);
}

function fillSelects() {
  const departmentOptions = state.departments.map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join('');
  $('#userDepartmentSelect').innerHTML = departmentOptions;
  $('#templateDepartmentSelect').innerHTML = departmentOptions;
  $('#accountUserSelect').innerHTML = state.users
    .filter((user) => user.role === 'staff' || user.id === state.me.id || state.me.role !== 'staff')
    .map((user) => `<option value="${user.id}">${escapeHtml(user.fullName)} (${roleName(user.role)})</option>`)
    .join('');
  if (state.me.role === 'staff') $('#accountUserSelect').value = state.me.id;
  const accountOptions = state.accounts.map((account, index) => `<option value="${account.id}">${escapeHtml(accountDisplayName(account, index))} · ${account.status}</option>`).join('');
  $('#chatAccountFilter').innerHTML = `<option value="">Tüm hesaplar</option>${accountOptions}`;
  $('#templateSelect').innerHTML = `<option value="">Manuel mesaj</option>${state.templates.map((template) => `<option value="${template.id}">${escapeHtml(template.title)}</option>`).join('')}`;
  renderChatAccountStrip();
  renderStaffAccountsMenu();
}

function renderStaffAccountsMenu() {
  if (state.me?.role !== 'staff') return;
  const submenu = $('#staffAccountsSubmenu');
  submenu.innerHTML = state.accounts.map((account, index) => `
    <button type="button" onclick="openStaffAccount('${account.id}')">
      ${escapeHtml(accountDisplayName(account, index))}
      <small>${escapeHtml(account.label)} · ${escapeHtml(account.status)}</small>
    </button>
  `).join('') || '<span class="nav-empty">Henüz bağlı hesap yok</span>';
}

function accountDisplayName(account, index) {
  return account.label && account.label !== 'WhatsApp Hesabı'
    ? account.label
    : `Hesap ${index + 1}`;
}

function renderChatAccountStrip() {
  const strip = $('#chatAccountStrip');
  if (!strip) return;
  strip.innerHTML = state.accounts.slice(0, 10).map((account, index) => `
    <button type="button" class="${state.selectedChatAccountId === account.id ? 'active' : ''}" onclick="openStaffAccount('${account.id}')">
      <strong>${escapeHtml(accountDisplayName(account, index))}</strong>
      <small>${escapeHtml(account.phoneNumber || account.status)}</small>
    </button>
  `).join('') || '<div class="empty-state">Bağlı WhatsApp hesabı yok.</div>';
}

function openStaffAccount(accountId) {
  state.selectedChatAccountId = accountId;
  $('#chatAccountFilter').value = accountId;
  renderConversations();
  renderChatAccountStrip();
  switchView('chat');
}

function renderReports(reports) {
  if (state.me.role === 'staff') {
    const ownAccounts = state.accounts.filter((account) => account.userId === state.me.id);
    const ownConversations = state.conversations.filter((conversation) => conversation.userId === state.me.id);
    const lastConversation = ownConversations
      .slice()
      .sort((a, b) => String(b.lastMessageAt || b.updatedAt).localeCompare(String(a.lastMessageAt || a.updatedAt)))[0];
    $('#reportCards').innerHTML = [
      ['WhatsApp hesabım', ownAccounts.length],
      ['Bağlı hesap', ownAccounts.filter((account) => account.status === 'connected').length],
      ['Aktif sohbet', ownConversations.length],
      ['Son görüşme', lastConversation ? (lastConversation.customerName || lastConversation.customerPhone) : '-']
    ].map(([label, value]) => `<div class="card"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
    $('#reportUsers').innerHTML = `
      <div class="staff-dashboard">
        <div class="item">
          <h3>Bugünkü odak</h3>
          <p>WhatsApp hesabınızı bağlayın, şablonlardan hızlı mesaj gönderin ve gelen görüşmeleri hesaplar menüsünden takip edin.</p>
        </div>
        <div class="item">
          <h3>Hesaplar</h3>
          <p>Sol menüdeki <strong>Hesaplar</strong> başlığından bağladığınız her WhatsApp hesabına ayrı sohbet alanı olarak ulaşabilirsiniz.</p>
        </div>
      </div>
    `;
    return;
  }
  $('#reportCards').innerHTML = [
    ['Kullanıcı', reports.users],
    ['WhatsApp hesabı', reports.accounts],
    ['Bağlı hesap', reports.connectedAccounts],
    ['Sohbet', reports.conversations],
    ['Gelen mesaj', reports.incomingMessages],
    ['Giden mesaj', reports.outgoingMessages],
    ['Şablon kullanımı', reports.templatesUsed]
  ].map(([label, value]) => `<div class="card"><span>${label}</span><strong>${value}</strong></div>`).join('');
  $('#reportUsers').innerHTML = reports.byUser.map((item) => `
    <div class="row">
      <div><strong>${escapeHtml(item.user.fullName)}</strong><br><small>${roleName(item.user.role)} · ${departmentName(item.user.departmentId)}</small></div>
      <div>${item.accounts} hesap · ${item.conversations} sohbet · ${item.incomingMessages}/${item.outgoingMessages} mesaj</div>
    </div>
  `).join('');
}

function renderDepartments() {
  $('#departmentList').innerHTML = state.departments.map((department) => `
    <div class="item">
      <h3>${escapeHtml(department.name)}</h3>
      <span class="badge">${department.active ? 'Aktif' : 'Pasif'}</span>
    </div>
  `).join('');
}

function renderUsers() {
  $('#userList').innerHTML = state.users.map((user) => {
    const accounts = state.accounts.filter((account) => account.userId === user.id);
    const conversations = state.conversations.filter((conversation) => conversation.userId === user.id);
    const initials = user.fullName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    return `
      <div class="user-card">
        <div class="user-card-top">
          <div class="avatar">${escapeHtml(initials || 'U')}</div>
          <div>
            <strong>${escapeHtml(user.fullName)}</strong>
            <small>@${escapeHtml(user.username)}</small>
          </div>
          <span class="badge">${user.active ? 'Aktif' : 'Pasif'}</span>
        </div>
        <div class="user-meta">
          <span>${roleName(user.role)}</span>
          <span>${departmentName(user.departmentId)}</span>
        </div>
        <div class="metric-row">
          <div class="mini-metric"><strong>${accounts.length}</strong><span>Hesap</span></div>
          <div class="mini-metric"><strong>${conversations.length}</strong><span>Sohbet</span></div>
          <div class="mini-metric"><strong>${user.active ? 'Açık' : 'Kapalı'}</strong><span>Durum</span></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderPersonnel() {
  const staff = state.users.filter((user) => user.role === 'staff');
  $('#personnelList').innerHTML = staff.map((user) => {
    const accounts = state.accounts.filter((account) => account.userId === user.id);
    const conversations = state.conversations.filter((conversation) => conversation.userId === user.id);
    const connected = accounts.filter((account) => account.status === 'connected').length;
    const initials = user.fullName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    return `
      <div class="personnel-card">
        <div class="personnel-head">
          <div class="avatar">${escapeHtml(initials || 'P')}</div>
          <div>
            <strong>${escapeHtml(user.fullName)}</strong><br>
            <small>${escapeHtml(user.username)} · ${departmentName(user.departmentId)}</small>
          </div>
        </div>
        <div class="metric-row">
          <div class="mini-metric"><strong>${accounts.length}</strong><span>WhatsApp</span></div>
          <div class="mini-metric"><strong>${connected}</strong><span>Bağlı</span></div>
          <div class="mini-metric"><strong>${conversations.length}</strong><span>Sohbet</span></div>
        </div>
        <span class="badge">${user.active ? 'Aktif personel' : 'Pasif personel'}</span>
        <button type="button" class="secondary" onclick="openPersonnelPanel('${user.id}')">Paneli ve görüşmeleri görüntüle</button>
      </div>
    `;
  }).join('') || '<div class="item">Henüz personel bulunmuyor.</div>';
  if (state.selectedPersonnelId) renderPersonnelDetail(state.selectedPersonnelId);
}

function renderPersonnelDetail(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user) {
    $('#personnelDetail').classList.add('hidden');
    return;
  }
  const accounts = state.accounts.filter((account) => account.userId === user.id);
  const conversations = state.conversations.filter((conversation) => conversation.userId === user.id);
  const selectedConversation = conversations.find((conversation) => conversation.id === state.selectedPersonnelConversationId) || conversations[0] || null;
  state.selectedPersonnelConversationId = selectedConversation?.id || null;
  $('#personnelDetail').classList.remove('hidden');
  $('#personnelDetail').innerHTML = `
    <div class="detail-head">
      <div>
        <span class="eyebrow-dark">Personel paneli</span>
        <h3>${escapeHtml(user.fullName)}</h3>
        <p>${escapeHtml(user.username)} · ${departmentName(user.departmentId)} · ${accounts.length} WhatsApp hesabı · ${conversations.length} sohbet</p>
      </div>
      <button type="button" class="ghost" onclick="closePersonnelPanel()">Kapat</button>
    </div>
    <div class="detail-grid">
      <aside class="detail-list">
        <h4>WhatsApp hesapları</h4>
        ${accounts.map((account) => `
          <div class="detail-account">
            <strong>${escapeHtml(account.label)}</strong>
            <small>${escapeHtml(account.phoneNumber || 'Telefon etiketi yok')} · ${escapeHtml(account.status)}</small>
          </div>
        `).join('') || '<div class="empty-state">Bağlı hesap yok.</div>'}
        <h4>Görüşmeler</h4>
        <div class="conversation-mini-list">
          ${conversations.map((conversation) => `
            <button type="button" onclick="openPersonnelConversation('${conversation.id}')">
              <strong>${escapeHtml(conversation.customerName || conversation.customerPhone)}</strong>
              <small>${escapeHtml(conversation.customerPhone)} · ${escapeHtml(conversation.lastMessage?.text || 'Mesaj yok')}</small>
            </button>
          `).join('') || '<div class="empty-state">Henüz görüşme yok.</div>'}
        </div>
      </aside>
      <section class="detail-chat">
        <div class="detail-chat-head">
          ${selectedConversation ? `
            <strong>${escapeHtml(selectedConversation.customerName || selectedConversation.customerPhone)}</strong>
            <small>${escapeHtml(selectedConversation.customerPhone)}</small>
          ` : 'Görüşme seçin'}
        </div>
        <div id="personnelMessageList" class="messages compact-messages"></div>
      </section>
    </div>
  `;
  if (selectedConversation) loadPersonnelConversationMessages(selectedConversation.id);
}

async function openPersonnelPanel(userId) {
  state.selectedPersonnelId = userId;
  state.selectedPersonnelConversationId = null;
  renderPersonnelDetail(userId);
}

function closePersonnelPanel() {
  state.selectedPersonnelId = null;
  state.selectedPersonnelConversationId = null;
  state.personnelMessages = [];
  $('#personnelDetail').classList.add('hidden');
}

async function openPersonnelConversation(conversationId) {
  state.selectedPersonnelConversationId = conversationId;
  renderPersonnelDetail(state.selectedPersonnelId);
}

async function loadPersonnelConversationMessages(conversationId) {
  try {
    const data = await api(`/api/conversations/${conversationId}/messages`);
    state.personnelMessages = data.messages;
    const target = $('#personnelMessageList');
    if (!target) return;
    target.innerHTML = state.personnelMessages.map((message) => `
      <div class="message ${message.direction}">
        ${escapeHtml(message.text)}
        <small>${message.direction === 'in' ? 'Müşteri' : 'Panel'} · ${new Date(message.createdAt).toLocaleString('tr-TR')} · ${message.status}</small>
      </div>
    `).join('') || '<div class="empty-state">Bu görüşmede mesaj yok.</div>';
    target.scrollTop = target.scrollHeight;
  } catch (error) {
    flashError(error);
  }
}

function renderTemplates() {
  $('#templateList').innerHTML = state.templates.map((template) => `
    <div class="item">
      <h3>${escapeHtml(template.title)}</h3>
      <p>${escapeHtml(template.body)}</p>
      <small>${departmentName(template.departmentId)}</small>
    </div>
  `).join('');
}

function renderAccounts() {
  $('#accountList').innerHTML = state.accounts.map((account) => `
    <div class="account-card ${account.status}">
      <div class="account-card-head">
        <div>
          <span class="eyebrow-dark">WhatsApp oturumu</span>
          <h3>${escapeHtml(account.label)}</h3>
          <p>${escapeHtml(account.phoneNumber || 'Telefon etiketi yok')}</p>
        </div>
        <span class="status-pill ${account.status}">${accountStatusText(account.status)}</span>
      </div>
      <div class="connection-steps">
        ${renderConnectionStep('1', 'QR oluşturuldu', ['qr_required', 'connecting', 'connected'].includes(account.status))}
        ${renderConnectionStep('2', 'Telefon doğrulaması', ['connecting', 'connected'].includes(account.status))}
        ${renderConnectionStep('3', 'Bağlantı aktif', account.status === 'connected')}
      </div>
      <p class="account-reason">${escapeHtml(account.statusReason || '')}</p>
      ${account.qrCode ? `
        <div class="qr-panel">
          <div class="qr-countdown" data-qr-created-at="${escapeHtml(account.qrCreatedAt || '')}">QR süresi kontrol ediliyor</div>
          ${account.qrImage
            ? `<img class="qr-image" src="${escapeHtml(account.qrImage)}" alt="WhatsApp QR kodu">`
            : `<div class="qr-fallback">${escapeHtml(account.qrCode)}</div>`}
          <details class="qr-raw">
            <summary>QR ham verisi</summary>
            <code>${escapeHtml(account.qrCode)}</code>
          </details>
          <small>Telefonunuzdan WhatsApp > Bağlı Cihazlar > Cihaz Bağla adımlarını izleyerek QR kodu okutun.</small>
        </div>
      ` : ''}
      <div class="account-meta">
        <span>Sahip: ${escapeHtml(state.users.find((user) => user.id === account.userId)?.fullName || '')}</span>
        <span>Sağlık: ${escapeHtml(account.connectionHealth || '-')}</span>
        ${account.lastHeartbeatAt ? `<span>Son kontrol: ${new Date(account.lastHeartbeatAt).toLocaleString('tr-TR')}</span>` : ''}
      </div>
      <div class="account-actions">
        <button type="button" class="secondary" onclick="renameAccount('${account.id}')">Takma adı düzenle</button>
        ${account.status === 'connected'
          ? `<button type="button" onclick="checkAccountHealth('${account.id}')">Bağlantıyı kontrol et</button>`
          : `<button type="button" onclick="confirmQr('${account.id}')">QR okutuldu / bağlan</button>`}
        ${account.status !== 'connected' ? `<button type="button" class="secondary" onclick="refreshQr('${account.id}')">QR yenile</button>` : ''}
        <button type="button" class="danger" onclick="disconnectAccount('${account.id}')">Bağlantıyı kes</button>
      </div>
    </div>
  `).join('');
  startQrCountdowns();
}

async function renameAccount(id) {
  const account = state.accounts.find((item) => item.id === id);
  const label = prompt('Hesap takma adı', account?.label || '');
  if (!label || !label.trim()) return;
  try {
    await api(`/api/accounts/${id}`, { method: 'PATCH', body: { label: label.trim() } });
    flash('Hesap takma adı güncellendi');
    await refreshAll();
  } catch (error) {
    flashError(error);
  }
}

function accountStatusText(status) {
  return {
    creating: 'Hazırlanıyor',
    qr_required: 'QR bekliyor',
    connecting: 'Bağlanıyor',
    connected: 'Bağlı',
    disconnected: 'Bağlantı kesildi',
    deleted: 'Silindi'
  }[status] || status;
}

function renderConnectionStep(number, label, active) {
  return `<div class="connection-step ${active ? 'active' : ''}"><strong>${number}</strong><span>${label}</span></div>`;
}

function startQrCountdowns() {
  document.querySelectorAll('.qr-countdown[data-qr-created-at]').forEach((element) => {
    const createdAt = new Date(element.dataset.qrCreatedAt).getTime();
    if (!createdAt) {
      element.textContent = 'QR yeni oluşturuluyor';
      return;
    }
    const remaining = Math.max(0, 45 - Math.floor((Date.now() - createdAt) / 1000));
    element.textContent = remaining > 0
      ? `QR geçerlilik süresi: ${remaining} sn`
      : 'QR süresi doldu, yenileyin';
  });
}

function renderConversations() {
  const filter = $('#chatAccountFilter').value || state.selectedChatAccountId;
  const conversations = state.conversations.filter((conversation) => !filter || conversation.accountId === filter);
  $('#conversationList').innerHTML = conversations.map((conversation) => `
    <button onclick="selectConversation('${conversation.id}')">
      <strong>${escapeHtml(conversation.customerName || conversation.customerPhone)}</strong><br>
      <small>${escapeHtml(conversation.customerPhone)} · ${escapeHtml(conversation.lastMessage?.text || 'Henüz mesaj yok')}</small>
    </button>
  `).join('');
}

async function selectConversation(id) {
  state.currentConversation = state.conversations.find((conversation) => conversation.id === id);
  $('#conversationHeader').textContent = `${state.currentConversation.customerName} · ${state.currentConversation.customerPhone}`;
  $('#customerPhone').value = state.currentConversation.customerPhone;
  state.selectedChatAccountId = state.currentConversation.accountId;
  $('#chatAccountFilter').value = state.currentConversation.accountId;
  renderChatAccountStrip();
  await loadMessages(id);
}

async function loadMessages(id) {
  const data = await api(`/api/conversations/${id}/messages`);
  state.messages = data.messages;
  $('#messageList').innerHTML = state.messages.map((message) => `
    <div class="message ${message.direction}">
      ${escapeHtml(message.text)}
      <small>${message.direction === 'in' ? 'Müşteri' : 'Panel'} · ${new Date(message.createdAt).toLocaleString('tr-TR')} · ${message.status}</small>
    </div>
  `).join('');
  $('#messageList').scrollTop = $('#messageList').scrollHeight;
}

function switchView(view) {
  $$('.view').forEach((element) => element.classList.add('hidden'));
  $(`#${view}`).classList.remove('hidden');
  $$('nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#viewTitle').textContent = document.querySelector(`nav button[data-view="${view}"]`).textContent;
}

function serializeForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

async function confirmQr(id) {
  try {
    await api(`/api/accounts/${id}/confirm-qr`, { method: 'POST' });
    flash('QR doğrulandı, bağlantı aktif edildi');
    await refreshAll();
  } catch (error) {
    flashError(error);
  }
}

async function disconnectAccount(id) {
  try {
    await api(`/api/accounts/${id}/disconnect`, { method: 'POST' });
    flash('Bağlantı kesildi');
    await refreshAll();
  } catch (error) {
    flashError(error);
  }
}

async function refreshQr(id) {
  try {
    await api(`/api/accounts/${id}/refresh-qr`, { method: 'POST' });
    flash('QR kod yenilendi');
    await refreshAll();
  } catch (error) {
    flashError(error);
  }
}

async function checkAccountHealth(id) {
  try {
    await api(`/api/accounts/${id}/health`, { method: 'POST' });
    flash('Bağlantı sağlıklı');
    await refreshAll();
  } catch (error) {
    flashError(error);
  }
}

window.confirmQr = confirmQr;
window.disconnectAccount = disconnectAccount;
window.refreshQr = refreshQr;
window.checkAccountHealth = checkAccountHealth;
window.renameAccount = renameAccount;
window.selectConversation = selectConversation;
window.openStaffAccount = openStaffAccount;
window.openPersonnelPanel = openPersonnelPanel;
window.closePersonnelPanel = closePersonnelPanel;
window.openPersonnelConversation = openPersonnelConversation;

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/auth/login', { method: 'POST', body: serializeForm(event.currentTarget) });
    await bootstrap();
  } catch (error) {
    alert(error.message);
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

$$('nav button[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-jump]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.jump)));
$('#staffAccountsToggle').addEventListener('click', () => {
  $('#staffAccountsMenu').classList.toggle('open');
});

$('#departmentForm').addEventListener('submit', (event) => handleFormSubmit(
  event,
  (form) => api('/api/departments', { method: 'POST', body: serializeForm(form) }),
  'Departman eklendi'
));

$('#userForm').addEventListener('submit', (event) => handleFormSubmit(
  event,
  (form) => api('/api/users', { method: 'POST', body: serializeForm(form) }),
  'Kullanıcı eklendi'
));

$('#generatePassword').addEventListener('click', () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  $('#userPassword').value = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
  flash('Güvenli şifre üretildi');
});

$('#copyPassword').addEventListener('click', async () => {
  try {
    const password = $('#userPassword').value;
    if (!password) {
      flash('Kopyalanacak şifre yok');
      return;
    }
    await navigator.clipboard.writeText(password);
    flash('Şifre panoya kopyalandı');
  } catch (error) {
    flashError(error);
  }
});

$('#templateForm').addEventListener('submit', (event) => handleFormSubmit(
  event,
  (form) => api('/api/templates', { method: 'POST', body: serializeForm(form) }),
  'Şablon eklendi'
));

$('#accountForm').addEventListener('submit', (event) => handleFormSubmit(
  event,
  (form) => api('/api/accounts', { method: 'POST', body: serializeForm(form) }),
  'WhatsApp hesabı eklendi'
));

$('#templateSelect').addEventListener('change', () => {
  const template = state.templates.find((item) => item.id === $('#templateSelect').value);
  if (template) $('#messageText').value = template.body;
});

$('#chatAccountFilter').addEventListener('change', () => {
  state.selectedChatAccountId = $('#chatAccountFilter').value;
  renderConversations();
  renderChatAccountStrip();
});

$('#sendForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const typedPhone = $('#customerPhone').value.trim();
    const sameConversationPhone = state.currentConversation && typedPhone === state.currentConversation.customerPhone;
    const body = {
      accountId: state.currentConversation?.accountId || state.selectedChatAccountId || $('#chatAccountFilter').value,
      conversationId: sameConversationPhone ? state.currentConversation.id : null,
      customerPhone: typedPhone,
      text: $('#messageText').value,
      templateId: $('#templateSelect').value || null
    };
    const result = await api('/api/messages/send', { method: 'POST', body });
    state.currentConversation = result.conversation;
    $('#messageText').value = '';
    $('#templateSelect').value = '';
    await refreshAll();
    await selectConversation(result.conversation.id);
    flash('Mesaj gönderildi');
  } catch (error) {
    flashError(error);
  }
});

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission().catch(() => {});
}

bootstrap();