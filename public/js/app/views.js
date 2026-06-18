import {
  state,
  $,
  $$,
  api,
  flash,
  flashError,
  roleName,
  departmentName,
  safeDepartmentName,
  userName,
  escapeHtml,
  normalizeSearchQuery
} from './core.js';

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
  loadTemplateContacts(state.templateContactSearch || '');
  fillSelects();
  applyAccountFormState();
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
    restoreLastView();
    connectEvents();
    bindPanelClickTracking();
    bindUserSearch();
  } catch {
    $('#login').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }
}

function isStaff() {
  return state.me?.role === 'staff';
}

function isAuditor() {
  return state.me?.role === 'auditor';
}

function isManager() {
  return state.me?.role === 'manager';
}

function isAdmin() {
  return state.me?.role === 'admin';
}

function isDepartmentSupervisor() {
  return isAuditor() || isManager();
}

function canManageCloudApiSettings() {
  return Boolean(state.me && ['admin', 'manager'].includes(state.me.role));
}

function canHideMessages() {
  return isAdmin() || isManager();
}

function canManageAccounts() {
  return Boolean(state.me && state.me.role !== 'staff');
}

const MAX_STAFF_ACCOUNTS = 10;

function applyRoleNavigation() {
  const staffHiddenNav = ['personnel', 'users', 'departments', 'cloudApi'];
  const auditorHiddenNav = ['users', 'departments', 'cloudApi', 'staffAudit'];
  const managerHiddenNav = ['departments'];
  $$('nav button[data-view]').forEach((button) => {
    const view = button.dataset.view;
    let hidden = false;
    if (isStaff()) hidden = staffHiddenNav.includes(view);
    if (isAuditor()) hidden = auditorHiddenNav.includes(view);
    if (isManager()) hidden = managerHiddenNav.includes(view);
    button.classList.toggle('hidden', hidden);
  });
  if (isStaff() || isDepartmentSupervisor()) {
    $('#chatAccountFilter')?.classList.add('hidden');
  } else {
    $('#chatAccountFilter')?.classList.remove('hidden');
  }
  const auditNav = $('#navStaffAudit');
  if (auditNav) {
    auditNav.classList.toggle('hidden', !['admin', 'manager'].includes(state.me.role));
  }
  const auditLogsNav = $('#navAuditLogs');
  if (auditLogsNav) {
    auditLogsNav.classList.toggle('hidden', !['admin', 'manager'].includes(state.me.role));
  }
  const cloudApiForm = $('#cloudApiForm');
  if (cloudApiForm) cloudApiForm.classList.toggle('hidden', !canManageCloudApiSettings());
  const accountForm = $('#accountForm');
  if (accountForm) {
    accountForm.querySelectorAll('.staff-hidden-field').forEach((field) => {
      field.classList.toggle('hidden', isStaff());
    });
  }
  const accountsHelp = $('#accountsHelp');
  if (accountsHelp) {
    if (isStaff()) {
      accountsHelp.textContent = `Buradan telefon numaranızı ekleyin (en fazla ${MAX_STAFF_ACCOUNTS}). Eklediğiniz numaralar Canlı Sohbet'te Hesap 1, Hesap 2… olarak görünür.`;
    } else if (isDepartmentSupervisor()) {
      accountsHelp.textContent = 'Departmanınızdaki personellerin WhatsApp hatlarını görüntüleyin. Mesajlaşmak için Canlı Sohbet sekmesinden hat seçin.';
    } else {
      accountsHelp.textContent = 'Personel yalnızca telefon numarası yazarak hesap açar; tüm hatlar paneldeki Cloud API üzerinden çalışır.';
    }
  }
  const templatesHelp = $('#templatesHelp');
  if (templatesHelp) {
    templatesHelp.textContent = (isStaff() || isDepartmentSupervisor())
      ? 'Kayıtlı şablonları görüntüleyebilirsiniz. Düzenleme ve ekleme yalnızca admin tarafından yapılır.'
      : 'Departman bazlı hızlı cevap ve satış metinlerini yönetin.';
  }
  const accountsNav = document.querySelector('nav button[data-view="accounts"]');
  if (accountsNav) accountsNav.textContent = (isStaff() || isDepartmentSupervisor()) ? 'Hesaplarım' : 'WhatsApp Hesapları';
  const accountsTitle = $('#accountsTitle');
  if (accountsTitle) accountsTitle.textContent = (isStaff() || isDepartmentSupervisor()) ? 'Hesaplarım' : 'WhatsApp Hesapları';
  const heroAccountsBtn = document.querySelector('.hero-actions button[data-jump="accounts"]');
  if (heroAccountsBtn) {
    heroAccountsBtn.classList.toggle('hidden', isDepartmentSupervisor());
    heroAccountsBtn.textContent = isStaff() ? 'Hesaplarım' : 'Hesap ekle';
  }
  const hero = $('#dashboard .hero');
  if (hero) hero.classList.toggle('hidden', isStaff() || isDepartmentSupervisor());
  $('#departmentForm')?.classList.toggle('hidden', !isAdmin());
  applyUserFormState();
  applyAccountFormState();
}

function applyUserFormState() {
  const form = $('#userForm');
  if (!form) return;
  const roleSelect = form.querySelector('select[name="role"]');
  const departmentSelect = $('#userDepartmentSelect');
  if (roleSelect) {
    roleSelect.querySelectorAll('option').forEach((option) => {
      if (isManager()) {
        option.hidden = option.value === 'admin' || option.value === 'manager';
      } else {
        option.hidden = false;
      }
    });
    if (isManager() && (roleSelect.value === 'admin' || roleSelect.value === 'manager')) {
      roleSelect.value = 'staff';
    }
  }
  let hiddenDepartment = form.querySelector('#userDepartmentHidden');
  if (departmentSelect && isManager()) {
    departmentSelect.innerHTML = state.departments
      .filter((department) => department.id === state.me.departmentId)
      .map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`)
      .join('');
    departmentSelect.value = state.me.departmentId;
    departmentSelect.disabled = true;
    departmentSelect.removeAttribute('name');
    if (!hiddenDepartment) {
      hiddenDepartment = document.createElement('input');
      hiddenDepartment.type = 'hidden';
      hiddenDepartment.name = 'departmentId';
      hiddenDepartment.id = 'userDepartmentHidden';
      form.appendChild(hiddenDepartment);
    }
    hiddenDepartment.value = state.me.departmentId;
  } else if (departmentSelect) {
    hiddenDepartment?.remove();
    departmentSelect.setAttribute('name', 'departmentId');
    departmentSelect.disabled = false;
  }
}

// Sayfa yenilemesinde kullanıcıyı her zaman panoya (Operasyon Merkezi) atmak
// yerine en son bulunduğu görünümden devam ettir. Geçersiz/gizli (rol dışı)
// görünümlerde sessizce varsayılan panoda kalınır.
function restoreLastView() {
  let view = null;
  try { view = localStorage.getItem('wp.activeView'); } catch { /* storage kapalı */ }
  if (!view || !document.getElementById(view)) return;
  const navButton = document.querySelector(`nav button[data-view="${view}"]`);
  if (navButton && navButton.classList.contains('hidden')) return;
  switchView(view);
  if (view === 'chat') restoreLastConversation();
}

// Sohbet görünümünde sayfayı yenilersek, en son açık olan konuşmayı yeniden aç
// (hâlâ erişilebilir listede ise).
function restoreLastConversation() {
  let id = null;
  try { id = localStorage.getItem('wp.activeConversationId'); } catch { /* storage kapalı */ }
  if (!id) return;
  if (state.conversations.some((conversation) => conversation.id === id)) {
    selectConversation(id);
  }
}

let refreshTimer = null;
let pendingAfterFns = [];
async function refreshIncremental() {
  const [conversations, accounts] = await Promise.all([
    api('/api/conversations'),
    api('/api/accounts')
  ]);
  state.conversations = conversations.conversations;
  state.accounts = accounts.accounts;
  state.lastMessageIds = new Set(
    state.conversations.map((conversation) => conversation.lastMessage?.id).filter(Boolean)
  );
  renderConversations();
  renderChatAccountStrip();
  renderAccounts();
}

function scheduleRefresh(afterFn) {
  if (afterFn) pendingAfterFns.push(afterFn);
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const handlers = pendingAfterFns;
    pendingAfterFns = [];
    const previousMessageIds = new Set(state.lastMessageIds);
    const activeView = document.querySelector('.view:not(.hidden)')?.id;
    try {
      if (activeView === 'chat') await refreshIncremental();
      else await refreshAll();
    } catch (error) {
      if (error?.message?.includes('Oturum')) {
        flashError(new Error('Oturum süresi doldu, lütfen tekrar giriş yapın'));
        $('#login')?.classList.remove('hidden');
        $('#app')?.classList.add('hidden');
        return;
      }
      flashError(error);
      return;
    }
    for (const handler of handlers) {
      try {
        await handler(previousMessageIds);
      } catch (error) {
        flashError(error);
      }
    }
  }, 350);
}

// WhatsApp bildirimine benzeyen kısa, yumuşak çift ton ("di-dink").
function playNotify() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    const notes = [
      { freq: 1175, start: 0, dur: 0.12 },    // D6
      { freq: 1568, start: 0.09, dur: 0.20 }  // G6
    ];
    notes.forEach((note) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      const t0 = now + note.start;
      oscillator.frequency.setValueAtTime(note.freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);
      oscillator.connect(gain).connect(master);
      oscillator.start(t0);
      oscillator.stop(t0 + note.dur + 0.03);
    });
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {}
}

function connectEvents() {
  if (state.eventsSource) return;
  const events = new EventSource('/api/events');
  state.eventsSource = events;

  const onMessageCreated = () => scheduleRefresh(async (previousMessageIds) => {
    const newIncoming = state.conversations
      .map((conversation) => conversation.lastMessage)
      .filter((message) => message && message.direction === 'in' && !previousMessageIds.has(message.id));
    if (newIncoming.length > 0) {
      playNotify();
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Yeni WhatsApp mesajı', { body: 'Yeni müşteri mesajı geldi' });
      }
    }
    const activeView = document.querySelector('.view:not(.hidden)')?.id;
    if (state.currentConversation && activeView === 'chat') {
      await loadMessages(state.currentConversation.id);
      await markConversationRead(state.currentConversation.id);
      renderConversations();
      renderChatAccountStrip();
    }
  });

  events.addEventListener('message.created', onMessageCreated);
  events.addEventListener('account.updated', () => scheduleRefresh());
  events.onerror = () => {
    events.close();
    state.eventsSource = null;
    setTimeout(connectEvents, 3000);
  };
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
  const accountOptions = visibleChatAccounts().map((account, index) => `<option value="${account.id}">${escapeHtml(accountDisplayName(account, index))} · ${account.status}</option>`).join('');
  $('#chatAccountFilter').innerHTML = `<option value="">Tüm hesaplar</option>${accountOptions}`;
  // Şablon seçici yalnızca aktif şablonları listeler: pasif şablonlar mesaj
  // gönderiminde kullanılmaz. Admin pasif şablonları liste ekranında görüp
  // yönetebilir, ancak buradaki gönderim dropdown'ında bilinçli olarak gizlenir.
  refreshTemplateSelect();
  renderChatAccountStrip();
  refreshComposerState();
  applyUserFormState();
}

function departmentStaffAccounts() {
  const staffIds = new Set(
    state.users
      .filter((user) => user.role === 'staff' && user.departmentId === state.me?.departmentId)
      .map((user) => user.id)
  );
  return state.accounts
    .filter((account) => staffIds.has(account.userId) && account.status !== 'deleted')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function visibleChatAccounts() {
  if (isStaff()) {
    return staffOwnAccounts().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  if (isDepartmentSupervisor()) return departmentStaffAccounts();
  return state.accounts;
}

function visibleDepartmentStaff() {
  if (isDepartmentSupervisor()) {
    return state.users.filter((user) => user.role === 'staff' && user.departmentId === state.me.departmentId);
  }
  return state.users.filter((user) => user.role === 'staff');
}

function visibleManagedUsers() {
  if (isManager()) {
    return state.users.filter((user) => (
      user.departmentId === state.me.departmentId && (user.role === 'staff' || user.role === 'auditor')
    ));
  }
  return state.users;
}

function matchesPersonSearch(user, query) {
  const q = normalizeSearchQuery(query);
  if (!q) return true;
  const haystack = [
    user.fullName,
    user.username,
    roleName(user.role)
  ].join(' ').toLocaleLowerCase('tr-TR');
  return haystack.includes(q);
}

function filteredManagedUsers() {
  return visibleManagedUsers().filter((user) => matchesPersonSearch(user, state.userSearchQuery));
}

function staffAuditForDisplay() {
  const audit = state.staffAuditData;
  if (!audit) return null;
  const q = state.staffAuditSearchQuery;
  if (!normalizeSearchQuery(q)) return audit;
  return {
    ...audit,
    byUser: audit.byUser.filter((row) => matchesPersonSearch(row.user, q))
  };
}

function bindUserSearch() {
  const input = $('#userSearchInput');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  input.addEventListener('input', () => {
    state.userSearchQuery = input.value;
    renderUsers();
  });
}

function canManageTargetUser(user) {
  if (!user || !state.me || user.id === state.me.id) return false;
  if (isAdmin()) return true;
  if (isManager()) {
    return user.departmentId === state.me.departmentId && (user.role === 'staff' || user.role === 'auditor');
  }
  return false;
}

function generateSecurePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

function openUserPasswordModal(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user || !canManageTargetUser(user)) {
    flashError(new Error('Bu kullanıcının şifresini değiştirme yetkiniz yok'));
    return;
  }
  const modal = $('#userPasswordModal');
  $('#userPasswordUserId').value = user.id;
  $('#userPasswordModalTitle').textContent = `${user.fullName} · şifre değiştir`;
  $('#userPasswordModalDesc').textContent = `@${user.username} kullanıcısı için yeni şifre belirleyin. Kayıttan sonra eski oturumlar kapanır.`;
  $('#userPasswordModalInput').value = '';
  modal?.classList.remove('hidden');
  modal?.setAttribute('aria-hidden', 'false');
  $('#userPasswordModalInput')?.focus();
}

function closeUserPasswordModal() {
  const modal = $('#userPasswordModal');
  modal?.classList.add('hidden');
  modal?.setAttribute('aria-hidden', 'true');
  $('#userPasswordForm')?.reset();
}

async function setUserActive(userId, active) {
  const user = state.users.find((item) => item.id === userId);
  if (!user || !canManageTargetUser(user)) {
    flashError(new Error('Bu kullanıcıyı düzenleme yetkiniz yok'));
    return;
  }
  const label = active ? 'aktifleştirmek' : 'pasife almak';
  if (!(await confirmAction(`${user.fullName} kullanıcısını ${label} istediğinize emin misiniz?`))) return;
  try {
    await api(`/api/users/${userId}`, { method: 'PATCH', body: { active } });
    await refreshAll();
    flash(active ? 'Kullanıcı aktifleştirildi' : 'Kullanıcı pasife alındı');
  } catch (error) {
    flashError(error);
  }
}

async function removeManagedUser(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user || !canManageTargetUser(user)) {
    flashError(new Error('Bu kullanıcıyı silme yetkiniz yok'));
    return;
  }
  const confirmed = await confirmAction(
    `${user.fullName} (@${user.username}) kalıcı olarak silinecek. `
    + 'Bu işlem pasife alma değildir; kullanıcı kaydı, WhatsApp hesapları ve sohbetleri tamamen kaldırılır. '
    + 'Geri alınamaz. Devam edilsin mi?'
  );
  if (!confirmed) return;
  try {
    const result = await api(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    if (result.deleted !== true) {
      if (result.user) {
        throw new Error('Sunucu güncel değil: silme isteği yalnızca pasife aldı. Lütfen panel sunucusunu yeniden başlatın.');
      }
      throw new Error(result.error || 'Kullanıcı kalıcı olarak silinemedi');
    }
    state.users = state.users.filter((item) => item.id !== userId);
    await refreshAll();
    flash(result.message || 'Kullanıcı kalıcı olarak silindi');
  } catch (error) {
    flashError(error);
  }
}

function activeTemplates() {
  return state.templates.filter((template) => template.active !== false);
}

function refreshTemplateSelect() {
  const templateOnly = isTemplateOnlyMode();
  const templates = activeTemplates();
  const options = templates.map((template) => {
    const metaMissing = templateOnly && !template.metaTemplateName;
    const hint = metaMissing ? ' (Meta adı gerekli)' : '';
    return `<option value="${template.id}"${metaMissing ? ' disabled' : ''}>${escapeHtml(template.title)}${escapeHtml(hint)}</option>`;
  }).join('');
  const placeholder = templateOnly ? 'Şablon seçin *' : 'Manuel mesaj / şablon';
  const emptyHint = templates.length ? '' : '<option value="" disabled>Departmanınıza tanımlı şablon yok</option>';
  const current = $('#templateSelect').value;
  $('#templateSelect').innerHTML = `<option value="">${placeholder}</option>${options || emptyHint}`;
  if (current && [...$('#templateSelect').options].some((option) => option.value === current && !option.disabled)) {
    $('#templateSelect').value = current;
  }
}

function isTemplateOnlyMode() {
  const conversation = state.currentConversation;
  if (conversation) return conversation.windowOpen === false;
  return Boolean($('#customerPhone')?.value?.trim());
}

function accountDisplayName(account, index) {
  if (isStaff()) return `Hesap ${index + 1}`;
  if (isDepartmentSupervisor()) {
    const owner = state.users.find((user) => user.id === account.userId);
    const ownerAccounts = departmentStaffAccounts().filter((item) => item.userId === account.userId);
    const ownerIndex = ownerAccounts.findIndex((item) => item.id === account.id);
    return `${owner?.fullName || 'Personel'} · Hesap ${ownerIndex + 1}`;
  }
  return account.label && account.label !== 'WhatsApp Hesabı'
    ? account.label
    : `Hesap ${index + 1}`;
}

function unreadForAccount(accountId) {
  return state.conversations
    .filter((conversation) => conversation.accountId === accountId)
    .reduce((total, conversation) => total + (conversation.unreadCount || 0), 0);
}

function renderChatAccountStrip() {
  const strip = $('#chatAccountStrip');
  if (!strip) return;
  const accounts = visibleChatAccounts();
  strip.innerHTML = accounts.slice(0, MAX_STAFF_ACCOUNTS).map((account, index) => {
    const unread = unreadForAccount(account.id);
    const badge = unread > 0 ? `<span class="account-unread">${unread > 99 ? '99+' : unread}</span>` : '';
    return `
    <button type="button" class="${state.selectedChatAccountId === account.id ? 'active' : ''}${unread > 0 ? ' has-unread' : ''}" onclick="openStaffAccount('${account.id}')">
      <span class="account-strip-row"><strong>${escapeHtml(accountDisplayName(account, index))}</strong>${badge}</span>
      <small>${escapeHtml(account.phoneNumber || account.status)}</small>
    </button>`;
  }).join('') || `<div class="empty-state">${isDepartmentSupervisor() ? 'Departmanınızda bağlı WhatsApp hesabı yok.' : 'Numara ekleyerek ilk hesabınızı oluşturun.'}</div>`;
}

function selectChatAccount(accountId) {
  state.selectedChatAccountId = accountId;
  $('#chatAccountFilter').value = accountId;
  renderConversations();
  renderChatAccountStrip();
  refreshComposerState();
  const activeView = document.querySelector('.view:not(.hidden)')?.id;
  if (activeView !== 'chat') switchView('chat');
}

function openStaffAccount(accountId) {
  selectChatAccount(accountId);
}

const MOTIVATION_QUOTES = [
  'Başarı, küçük çabaların her gün tekrarlanmasıdır.',
  'Bugün attığınız her adım, yarının güvenidir.',
  'İletişimde netlik, güvenin en hızlı yoludur.',
  'Her mesaj bir fırsat, her yanıt bir köprüdür.',
  'Disiplinli çalışma, sonuçları sessizce büyütür.',
  'Müşteriye değer veren ekip, her gün daha güçlü olur.',
  'Odaklan, dinle ve doğru anda doğru cevabı ver.',
  'Küçük iyilikler büyük bağlar kurar.',
  'Bugünün emeği, yarının başarı hikayesidir.',
  'Sabır ve istikrar, en sağlam büyüme formülüdür.',
  'Her yeni gün, daha iyi bir iletişim için yeni bir şanstır.',
  'Planlı çalışmak, panik yerine kontrol getirir.',
  'Güler yüz ve net bilgi, en etkili satış aracıdır.',
  'Takım ruhu, tek başına mümkün olmayanı mümkün kılar.',
  'Zorluklar geçicidir; azmin etkisi kalıcıdır.',
  'Doğru soruyu sormak, doğru cevabın yarısıdır.',
  'Hızlı değil, doğru iletişim kalıcıdır.',
  'Bugün bir kişiye umut verdin; bu büyük bir başarıdır.',
  'İşini sahiplenmek, fark yaratmanın en kısa yoludur.',
  'Her gün biraz daha iyi olmak, uzun vadede çok şey değiştirir.',
  'Güven inşa eden ekip, her krizde daha da güçlenir.',
  'Sadelik ve samimiyet, en güçlü mesajdır.',
  'Hedefin büyük olsun; adımların net olsun.',
  'Müşteri memnuniyeti, en değerli referanstır.',
  'Bugün dünden daha hazırsın; bunu kullan.',
  'İyi bir gün, iyi bir alışkanlıkla başlar.',
  'Azim, yetenekten daha uzun yol alır.',
  'Her görüşme, yeni bir güven kapısıdır.',
  'Sakin kal, net konuş, doğru yönlendir.',
  'Başarı bir varış değil, sürekli bir yolculuktur.',
  'Bugünün enerjisi, yarının sonuçlarını belirler.'
];

function dailyMotivationQuote() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  return MOTIVATION_QUOTES[dayOfYear % MOTIVATION_QUOTES.length];
}

function todayInputDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function formatFilterDateLabel(value) {
  try {
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  } catch {
    return String(value);
  }
}

function renderStaffMotivation() {
  const block = $('#staffMotivation');
  const hero = $('#dashboard .hero');
  if (!block) return;
  block.classList.remove('hidden');
  block.innerHTML = `
    <span class="eyebrow">Günün motivasyonu</span>
    <p class="staff-motivation-quote">${escapeHtml(dailyMotivationQuote())}</p>`;
  if (hero) hero.classList.add('hidden');
}

function renderStaffOpsFilter(selectedDate) {
  const filter = $('#staffOpsFilter');
  if (!filter) return;
  const date = selectedDate || state.staffOpsDate || todayInputDate();
  state.staffOpsDate = date;
  filter.classList.remove('hidden');
  filter.innerHTML = `
    <label class="staff-date-filter">
      <span>Tarih filtresi</span>
      <input type="date" id="staffOpsDateInput" value="${escapeHtml(date)}">
    </label>
    <small>Seçilen gün: ${escapeHtml(formatFilterDateLabel(date))} · Yalnızca şablon ile gönderilen ilk iletişimler sayılır.</small>`;
  const input = $('#staffOpsDateInput');
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('change', () => {
      state.staffOpsDate = input.value;
      loadStaffOperations(input.value);
    });
  }
}

async function loadStaffOperations(date) {
  if (!isStaff()) return;
  try {
    const query = date || state.staffOpsDate || todayInputDate();
    const data = await api(`/api/reports/staff-operations?date=${encodeURIComponent(query)}`);
    renderStaffOperations(data.operations);
  } catch (error) {
    flashError(error);
  }
}

let templateContactSearchTimer = null;

async function loadTemplateContacts(search = '') {
  try {
    const query = String(search || '').trim();
    const suffix = query ? `?search=${encodeURIComponent(query)}` : '';
    const data = await api(`/api/reports/template-contacts${suffix}`);
    renderTemplateContacts(data.log);
  } catch (error) {
    flashError(error);
  }
}

function exportTemplateContacts() {
  const query = String(state.templateContactSearch || '').trim();
  const suffix = query ? `?search=${encodeURIComponent(query)}` : '';
  window.location.href = `/api/reports/template-contacts/export${suffix}`;
}

function ensureTemplateContactsFilter() {
  const filter = $('#templateContactsFilter');
  if (!filter) return;
  if (!filter.dataset.bound) {
    filter.dataset.bound = '1';
    filter.innerHTML = `
      <label class="staff-date-filter template-contacts-search">
        <span>Numara ara</span>
        <input type="search" id="templateContactsSearchInput" placeholder="90555..." autocomplete="off">
      </label>
      <small id="templateContactsCount"></small>`;
    const input = $('#templateContactsSearchInput');
    if (input) {
      input.addEventListener('input', () => {
        state.templateContactSearch = input.value;
        clearTimeout(templateContactSearchTimer);
        templateContactSearchTimer = setTimeout(() => {
          loadTemplateContacts(state.templateContactSearch);
        }, 300);
      });
    }
  }
  const input = $('#templateContactsSearchInput');
  if (input && document.activeElement !== input) {
    input.value = state.templateContactSearch || '';
  }
}

function renderTemplateContacts(log) {
  const desc = $('#templateContactsDesc');
  const exportBtn = $('#templateContactsExport');
  const table = $('#templateContactsTable');
  if (!table) return;

  if (desc) {
    desc.textContent = isStaff()
      ? 'Şablon mesajı gönderdiğiniz numaralar ve iletişim zamanları.'
      : 'Departman personelinin şablon mesajı gönderdiği numaralar ve iletişim zamanları.';
  }
  if (exportBtn) {
    exportBtn.classList.toggle('hidden', !log?.canExport);
    if (!exportBtn.dataset.bound) {
      exportBtn.dataset.bound = '1';
      exportBtn.addEventListener('click', exportTemplateContacts);
    }
  }

  ensureTemplateContactsFilter();
  const count = $('#templateContactsCount');
  if (count) {
    count.textContent = `${log.total} kayıt listeleniyor${log.search ? ` · Arama: ${log.search}` : ''}`;
  }

  const colSpan = log.showStaff ? 6 : 4;
  const head = log.showStaff
    ? '<th>Personel</th><th>Departman</th><th>Numara</th><th>Müşteri</th><th>Tarih / Saat</th><th>Şablon</th>'
    : '<th>Numara</th><th>Müşteri</th><th>Tarih / Saat</th><th>Şablon</th>';
  const rows = log.entries.map((entry) => {
    const staffCells = log.showStaff
      ? `<td data-label="Personel"><strong>${escapeHtml(entry.staffName)}</strong><br><small>@${escapeHtml(entry.staffUsername)}</small></td>
         <td data-label="Departman">${escapeHtml(entry.departmentName)}</td>`
      : '';
    return `<tr>
      ${staffCells}
      <td data-label="Numara"><code>${escapeHtml(entry.phone)}</code></td>
      <td data-label="Müşteri">${escapeHtml(entry.customerName || entry.phone)}</td>
      <td data-label="Tarih">${escapeHtml(formatDateTime(entry.contactedAt))}</td>
      <td data-label="Şablon">${escapeHtml(entry.templateTitle)}</td>
    </tr>`;
  }).join('');

  table.innerHTML = `
    <div class="staff-audit-table-scroll">
      <table class="staff-audit-table template-contacts-table">
        <thead><tr>${head}</tr></thead>
        <tbody>
          ${rows || `<tr><td colspan="${colSpan}">Kayıt bulunamadı.</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function renderStaffOperations(operations) {
  renderStaffOpsFilter(operations.date);
  const heading = $('#reportSectionHeading');
  const desc = $('#reportSectionDesc');
  if (heading) heading.textContent = 'Şablon performansı';
  if (desc) {
    desc.textContent = `${formatFilterDateLabel(operations.date)} tarihinde şablonla ulaştığınız farklı kişi sayıları.`;
  }
  $('#reportCards').innerHTML = `
    <div class="card staff-ops-total">
      <span>Toplam ilk iletişim</span>
      <strong>${operations.totalFirstContacts}</strong>
      <small>Seçilen günde şablonla ilk kez ulaşılan kişi</small>
    </div>`;
  $('#reportUsers').innerHTML = `
    <div class="staff-template-stats">
      ${operations.byTemplate.map((row) => `
        <div class="item staff-template-card">
          <span class="eyebrow-dark">Şablon</span>
          <h3>${escapeHtml(row.title)}</h3>
          <p class="staff-template-count"><strong>${row.uniqueRecipients}</strong> farklı kişi</p>
          <small>${escapeHtml(formatFilterDateLabel(operations.date))} tarihinde şablon ile iletildi</small>
        </div>
      `).join('') || '<div class="item">Bu departmanda tanımlı şablon bulunmuyor.</div>'}
    </div>`;
}

function renderReports(reports) {
  if (state.me.role === 'staff') {
    renderStaffMotivation();
    loadStaffOperations(state.staffOpsDate || todayInputDate());
    return;
  }
  $('#staffMotivation')?.classList.add('hidden');
  $('#staffOpsFilter')?.classList.add('hidden');
  $('#dashboard .hero')?.classList.toggle('hidden', isStaff());
  if (isDepartmentSupervisor()) {
    const staffRows = reports.byUser.filter((item) => item.user.role === 'staff');
    const heading = $('#reportSectionHeading');
    const desc = $('#reportSectionDesc');
    if (heading) heading.textContent = 'Departman personeli';
    if (desc) desc.textContent = `${departmentName(state.me.departmentId)} departmanındaki personel ve iletişim özeti`;
    $('#reportCards').innerHTML = [
      ['Departman personeli', staffRows.length],
      ['WhatsApp hesabı', reports.accounts],
      ['Bağlı hesap', reports.connectedAccounts],
      ['Sohbet', reports.conversations],
      ['Gelen mesaj', reports.incomingMessages],
      ['Giden mesaj', reports.outgoingMessages]
    ].map(([label, value]) => `<div class="card"><span>${label}</span><strong>${value}</strong></div>`).join('');
    $('#reportUsers').innerHTML = staffRows.map((item) => `
      <div class="row">
        <div><strong>${escapeHtml(item.user.fullName)}</strong><br><small>${escapeHtml(item.user.username)}</small></div>
        <div>${item.accounts} hesap · ${item.conversations} sohbet · ${item.incomingMessages}/${item.outgoingMessages} mesaj</div>
      </div>
    `).join('') || '<div class="item">Departmanınızda personel bulunmuyor.</div>';
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
      <div><strong>${escapeHtml(item.user.fullName)}</strong><br><small>${roleName(item.user.role)} · ${safeDepartmentName(item.user.departmentId)}</small></div>
      <div>${item.accounts} hesap · ${item.conversations} sohbet · ${item.incomingMessages}/${item.outgoingMessages} mesaj</div>
    </div>
  `).join('');
}

function departmentMemberCount(departmentId) {
  return state.users.filter((user) => (
    user.departmentId === departmentId
    && (user.role === 'staff' || user.role === 'manager' || user.role === 'auditor')
  )).length;
}

function renderDepartments() {
  $('#departmentAdminTools')?.classList.toggle('hidden', !isAdmin());
  $('#departmentList').innerHTML = state.departments.map((department) => {
    const members = departmentMemberCount(department.id);
    const actions = isAdmin() ? `
      <div class="user-card-actions">
        <button type="button" class="secondary" onclick="openDepartmentModal('${department.id}')">Düzenle</button>
        <button type="button" class="danger" data-department-action="delete" data-department-id="${department.id}" title="Departmanı ve bağlı personel, yönetici ve denetçileri kalıcı olarak siler">Kalıcı sil</button>
      </div>` : '';
    return `
    <div class="item">
      <h3>${escapeHtml(department.name)}</h3>
      <span class="badge">${department.active ? 'Aktif' : 'Pasif'}</span>
      <small>${members} kullanıcı (personel / yönetici / denetçi)</small>
      ${actions}
    </div>`;
  }).join('');
}

function renderUsers() {
  const allUsers = visibleManagedUsers();
  const users = filteredManagedUsers();
  const emptyMessage = allUsers.length && normalizeSearchQuery(state.userSearchQuery)
    ? 'Arama kriterine uygun kullanıcı bulunamadı.'
    : 'Yönetilebilir kullanıcı bulunmuyor.';
  $('#userList').innerHTML = users.length ? users.map((user) => {
    const accounts = state.accounts.filter((account) => account.userId === user.id);
    const conversations = state.conversations.filter((conversation) => conversation.userId === user.id);
    const initials = user.fullName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    const manageable = canManageTargetUser(user);
    const actions = manageable ? `
        <div class="user-card-actions">
          <button type="button" class="secondary" data-user-action="password" data-user-id="${user.id}">Şifre değiştir</button>
          ${user.active
            ? `<button type="button" class="secondary" data-user-action="deactivate" data-user-id="${user.id}">Pasife al</button>`
            : `<button type="button" class="secondary" data-user-action="activate" data-user-id="${user.id}">Aktifleştir</button>`}
          <button type="button" class="danger" data-user-action="delete" data-user-id="${user.id}" title="Kullanıcıyı ve tüm verilerini kalıcı olarak siler">Kalıcı sil</button>
          ${isAdmin() ? `<button type="button" class="secondary" data-user-action="export" data-user-id="${user.id}">Veri dışa aktar</button>` : ''}
        </div>` : '';
    return `
      <div class="user-card ${user.active ? '' : 'inactive'}">
        <div class="user-card-top">
          <div class="avatar">${escapeHtml(initials || 'U')}</div>
          <div>
            <strong>${escapeHtml(user.fullName)}</strong>
            <small>@${escapeHtml(user.username)}</small>
          </div>
          <span class="badge ${user.active ? '' : 'inactive-badge'}">${user.active ? 'Aktif' : 'Pasif'}</span>
        </div>
        <div class="user-meta">
          <span>${roleName(user.role)}</span>
          <span>${safeDepartmentName(user.departmentId)}</span>
        </div>
        <div class="metric-row">
          <div class="mini-metric"><strong>${accounts.length}</strong><span>Hesap</span></div>
          <div class="mini-metric"><strong>${conversations.length}</strong><span>Sohbet</span></div>
          <div class="mini-metric"><strong>${user.active ? 'Açık' : 'Kapalı'}</strong><span>Durum</span></div>
        </div>
        ${actions}
      </div>
    `;
  }).join('') : `<div class="item">${emptyMessage}</div>`;
}

function renderPersonnel() {
  const staff = visibleDepartmentStaff();
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
            <small>${escapeHtml(user.username)} · ${safeDepartmentName(user.departmentId)}</small>
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
        <p>${escapeHtml(user.username)} · ${safeDepartmentName(user.departmentId)} · ${accounts.length} WhatsApp hesabı · ${conversations.length} sohbet</p>
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
    target.innerHTML = renderMessagesHtml(state.personnelMessages);
    scrollMessagesToBottom(target);
  } catch (error) {
    flashError(error);
  }
}

function canManageTemplates() {
  return Boolean(state.me && state.me.role === 'admin');
}

async function loadCloudApiSettings() {
  const status = $('#cloudApiStatus');
  const form = $('#cloudApiForm');
  if (!status) return;
  try {
    const data = await api('/api/settings/cloud-api');
    const settings = data.settings;
    state.cloudApiSettings = settings;
    const configured = settings.configured;
    status.innerHTML = `
      <h3>${configured ? 'Cloud API yapılandırıldı' : 'Cloud API henüz yapılandırılmadı'}</h3>
      <p>${configured
        ? 'Tüm personel bu bağlantı üzerinden mesajlaşır. Kimlik bilgileri yalnızca admin/yönetici tarafından güncellenir.'
        : 'Mesajlaşma başlamadan önce admin veya yöneticinin Phone Number ID ve Access Token girmesi gerekir.'}</p>
      <div class="account-meta">
        <span>Phone ID: ${escapeHtml(settings.phoneNumberId || '-')}</span>
        <span>WABA: ${escapeHtml(settings.wabaId || '-')}</span>
        <span>Token: ${settings.hasAccessToken ? 'Tanımlı' : 'Eksik'}</span>
        <span>Webhook token: ${settings.webhookVerifyToken ? 'Tanımlı' : 'Eksik'}</span>
        <span>App Secret: ${settings.hasAppSecret ? 'Tanımlı' : 'Eksik'}</span>
        ${settings.updatedAt ? `<span>Son güncelleme: ${formatDateTime(settings.updatedAt)}</span>` : ''}
      </div>`;
    if (form && canManageCloudApiSettings()) {
      form.phoneNumberId.value = settings.phoneNumberId || '';
      form.wabaId.value = settings.wabaId || '';
      form.baseUrl.value = settings.baseUrl || '';
      form.webhookVerifyToken.value = settings.webhookVerifyToken || '';
      form.accessToken.value = '';
      form.appSecret.value = '';
    }
  } catch (error) {
    flashError(error);
  }
}

function staffOwnAccounts() {
  return state.accounts.filter((account) => account.userId === state.me?.id && account.status !== 'deleted');
}

function applyAccountFormState() {
  const form = $('#accountForm');
  if (!form) return;
  if (isDepartmentSupervisor()) {
    form.classList.add('hidden');
    const ownAccounts = visibleChatAccounts();
    if (!state.selectedChatAccountId && ownAccounts.length) {
      state.selectedChatAccountId = ownAccounts[0].id;
      $('#chatAccountFilter').value = ownAccounts[0].id;
    }
    return;
  }
  if (!isStaff()) {
    form.classList.remove('hidden');
    return;
  }
  const ownAccounts = visibleChatAccounts();
  const atLimit = ownAccounts.length >= MAX_STAFF_ACCOUNTS;
  form.classList.toggle('hidden', atLimit);
  const submitBtn = $('#accountSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = atLimit;
    submitBtn.textContent = atLimit ? 'Limit doldu' : 'Numara ekle';
  }
  if (!state.selectedChatAccountId && ownAccounts.length) {
    state.selectedChatAccountId = ownAccounts[0].id;
    $('#chatAccountFilter').value = ownAccounts[0].id;
  }
}

const STAFF_AUDIT_INACTIVE_MS = 24 * 60 * 60 * 1000;

function staffAuditInitials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'P';
}

function staffAuditHealth(row) {
  if (row.errorCount > 0) return 'risk';
  if (row.inactiveMs !== null && row.inactiveMs > STAFF_AUDIT_INACTIVE_MS) return 'warn';
  return 'ok';
}

function staffAuditHealthLabel(health) {
  return {
    ok: 'Aktif',
    warn: 'Uzun süredir yok',
    risk: 'Hata var'
  }[health] || 'Aktif';
}

function formatAuditDateTime(value) {
  if (!value) return '—';
  return formatDateTime(value);
}

function formatDurationHms(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours} sa ${minutes} dk ${seconds} sn`;
}

function staffAuditAwayMs(row, nowMs = Date.now()) {
  if (row.inactiveMs === null || row.inactiveMs === undefined || !Number.isFinite(row.inactiveMs)) return null;
  const loadedAt = state.staffAuditLoadedAt || nowMs;
  return row.inactiveMs + Math.max(0, nowMs - loadedAt);
}

function staffAuditInteractionTime(row) {
  if (!row.lastPanelClickAt) return '—';
  return formatTimeShort(row.lastPanelClickAt) || '—';
}

function staffAuditAwayMarkup(row) {
  const awayMs = staffAuditAwayMs(row);
  if (awayMs === null) return '—';
  const loadedAt = state.staffAuditLoadedAt || Date.now();
  const text = formatDurationHms(awayMs);
  return `<span class="staff-audit-away" data-audit-away data-away-ms="${awayMs}" data-loaded-at="${loadedAt}">${escapeHtml(text)}</span>`;
}

let staffAuditTicker = null;

function startStaffAuditTicker() {
  stopStaffAuditTicker();
  staffAuditTicker = setInterval(updateStaffAuditAwayTimes, 1000);
}

function stopStaffAuditTicker() {
  if (!staffAuditTicker) return;
  clearInterval(staffAuditTicker);
  staffAuditTicker = null;
}

function updateStaffAuditAwayTimes() {
  const activeView = document.querySelector('.view:not(.hidden)')?.id;
  if (activeView !== 'staffAudit') {
    stopStaffAuditTicker();
    return;
  }
  const now = Date.now();
  document.querySelectorAll('[data-audit-away]').forEach((element) => {
    const baseMs = Number(element.dataset.awayMs);
    const loadedAt = Number(element.dataset.loadedAt);
    if (!Number.isFinite(baseMs) || !Number.isFinite(loadedAt)) {
      element.textContent = '—';
      return;
    }
    element.textContent = formatDurationHms(baseMs + Math.max(0, now - loadedAt));
  });
}

function pingPanelInteraction() {
  api('/api/activity/click', { method: 'POST' }).catch(() => {});
}

function bindPanelClickTracking() {
  if (state.panelClickBound) return;
  state.panelClickBound = true;
  let lastPing = 0;
  const pingDelayMs = 3000;
  const registerActivity = () => {
    const now = Date.now();
    if (now - lastPing < pingDelayMs) return;
    lastPing = now;
    pingPanelInteraction();
  };
  ['click', 'keydown', 'pointerdown', 'touchstart', 'scroll'].forEach((eventName) => {
    document.addEventListener(eventName, registerActivity, { capture: true, passive: true });
  });
  pingPanelInteraction();
}

function renderStaffAuditSummary(audit, displayAudit = audit) {
  const summary = $('#staffAuditSummary');
  if (!summary) return;
  const rows = displayAudit?.byUser || audit.byUser;
  const scopedCount = normalizeSearchQuery(state.staffAuditSearchQuery) ? rows.length : audit.staffCount;
  const errorStaff = rows.filter((row) => row.errorCount > 0).length;
  const inactiveStaff = rows.filter((row) => (
    row.inactiveMs !== null && row.inactiveMs > STAFF_AUDIT_INACTIVE_MS
  )).length;
  const activeStaff = Math.max(0, scopedCount - inactiveStaff);
  summary.innerHTML = `
    <div class="staff-audit-kpi">
      <span>Toplam personel</span>
      <strong>${scopedCount}</strong>
      <small>Denetim kapsamındaki aktif personel</small>
    </div>
    <div class="staff-audit-kpi">
      <span>Görülmemiş mesaj</span>
      <strong>${audit.unseenIncoming}</strong>
      <small>Henüz okunmamış gelen mesaj</small>
    </div>
    <div class="staff-audit-kpi warn">
      <span>Uzun süredir yok</span>
      <strong>${inactiveStaff}</strong>
      <small>24 saatten fazla panelde etkileşmeyen</small>
    </div>
    <div class="staff-audit-kpi risk">
      <span>Hatalı işlem</span>
      <strong>${errorStaff}</strong>
      <small>En az bir hata kaydı olan personel</small>
    </div>
    <div class="staff-audit-kpi ok">
      <span>Aktif personel</span>
      <strong>${activeStaff}</strong>
      <small>Son 24 saatte panelde etkileşen</small>
    </div>`;
}

function renderStaffAuditCard(row) {
  const health = staffAuditHealth(row);
  const errorBlock = row.errorCount > 0
    ? `<div class="staff-audit-alert">
        <span class="staff-audit-alert-title">${row.errorCount} hata kaydı</span>
        <p class="staff-audit-alert-text">${row.lastErrorMessage ? escapeHtml(row.lastErrorMessage) : 'Son hata mesajı kayıtlı değil'}</p>
      </div>`
    : '';
  return `
    <article class="staff-audit-card ${health}">
      <header class="staff-audit-card-head">
        <div class="staff-audit-person">
          <div class="avatar">${escapeHtml(staffAuditInitials(row.user.fullName))}</div>
          <div>
            <strong>${escapeHtml(row.user.fullName)}</strong>
            <small>@${escapeHtml(row.user.username)}</small>
          </div>
        </div>
        <span class="audit-status-pill ${health}">${staffAuditHealthLabel(health)}</span>
      </header>
      <section class="staff-audit-block">
        <h4>Mesajlaşma</h4>
        <div class="metric-row">
          <div class="mini-metric"><strong>${row.sentCount}</strong><span>Gönderilen</span></div>
          <div class="mini-metric"><strong>${row.seenCount}</strong><span>Görülen</span></div>
          <div class="mini-metric"><strong>${row.respondedCount}</strong><span>Yanıtlanan</span></div>
        </div>
        <p class="staff-audit-note">Ortalama ilk yanıt: <strong>${formatDuration(row.avgFirstResponseMs)}</strong></p>
      </section>
      <section class="staff-audit-block">
        <h4>Panel aktivitesi</h4>
        <dl class="staff-audit-facts">
          <div class="staff-audit-fact-row">
            <dt>Son giriş</dt>
            <dd>${formatAuditDateTime(row.lastLoginAt)}</dd>
          </div>
          <div class="staff-audit-fact-row">
            <dt>Son etkileşim</dt>
            <dd>${staffAuditInteractionTime(row)}</dd>
          </div>
          <div class="staff-audit-fact-row">
            <dt>Son görülme</dt>
            <dd class="staff-audit-away-cell">
              ${staffAuditAwayMarkup(row)}
              <small class="staff-audit-click-at">Panelde son etkileşimden bu yana geçen süre</small>
            </dd>
          </div>
          <div class="staff-audit-fact-row">
            <dt>Son yanıt</dt>
            <dd>${formatAuditDateTime(row.lastRespondedAt)}</dd>
          </div>
          <div class="staff-audit-fact-row">
            <dt>Son mesaj görme</dt>
            <dd>${formatAuditDateTime(row.lastSeenAt)}</dd>
          </div>
        </dl>
      </section>
      ${errorBlock}
    </article>`;
}

function renderStaffAuditCards(audit) {
  const cards = $('#staffAuditCards');
  if (!cards) return;
  const emptyMessage = state.staffAuditData?.byUser?.length && normalizeSearchQuery(state.staffAuditSearchQuery)
    ? 'Arama kriterine uygun personel bulunamadı.'
    : 'Bu kapsamda denetlenecek personel bulunmuyor.';
  cards.innerHTML = audit.byUser.length
    ? audit.byUser.map((row) => renderStaffAuditCard(row)).join('')
    : `<div class="staff-audit-empty">${emptyMessage}</div>`;
}

function renderStaffAuditTable(audit) {
  const tableWrap = $('#staffAuditTable');
  if (!tableWrap) return;
  const rows = audit.byUser.map((row) => {
    const health = staffAuditHealth(row);
    return `
      <tr class="${health}">
        <td class="staff-audit-person-cell">
          <div class="staff-audit-person compact">
            <div class="avatar">${escapeHtml(staffAuditInitials(row.user.fullName))}</div>
            <div>
              <strong>${escapeHtml(row.user.fullName)}</strong>
              <small>@${escapeHtml(row.user.username)}</small>
            </div>
          </div>
        </td>
        <td data-label="Gönderilen">${row.sentCount}</td>
        <td data-label="Görülen">${row.seenCount}</td>
        <td data-label="Yanıtlanan">${row.respondedCount}</td>
        <td data-label="Ort. yanıt">${formatDuration(row.avgFirstResponseMs)}</td>
        <td data-label="Son giriş">${formatAuditDateTime(row.lastLoginAt)}</td>
        <td data-label="Son etkileşim">${staffAuditInteractionTime(row)}</td>
        <td data-label="Son görülme">${staffAuditAwayMarkup(row)}</td>
        <td data-label="Son yanıt">${formatAuditDateTime(row.lastRespondedAt)}</td>
        <td data-label="Son mesaj görme">${formatAuditDateTime(row.lastSeenAt)}</td>
        <td data-label="Hata">${row.errorCount}</td>
        <td data-label="Durum"><span class="audit-status-pill ${health}">${staffAuditHealthLabel(health)}</span></td>
      </tr>`;
  }).join('');
  tableWrap.innerHTML = `
    <div class="staff-audit-table-scroll">
      <table class="staff-audit-table">
        <thead>
          <tr class="staff-audit-group-row">
            <th rowspan="2">Personel</th>
            <th colspan="3">Mesajlar</th>
            <th rowspan="2">Ort. ilk yanıt</th>
            <th colspan="5">Panel aktivitesi</th>
            <th rowspan="2">Hata</th>
            <th rowspan="2">Durum</th>
          </tr>
          <tr>
            <th>Gönderilen</th>
            <th>Görülen</th>
            <th>Yanıtlanan</th>
            <th>Son giriş</th>
            <th>Son etkileşim</th>
            <th>Son görülme</th>
            <th>Son yanıt</th>
            <th>Son mesaj görme</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="12">${state.staffAuditData?.byUser?.length && normalizeSearchQuery(state.staffAuditSearchQuery) ? 'Arama kriterine uygun personel bulunamadı.' : 'Kayıt yok'}</td></tr>`}</tbody>
      </table>
    </div>`;
}

function setStaffAuditView(view) {
  state.staffAuditView = view === 'table' ? 'table' : 'cards';
  $('#staffAuditCards')?.classList.toggle('hidden', state.staffAuditView !== 'cards');
  $('#staffAuditCardsHead')?.classList.toggle('hidden', state.staffAuditView !== 'cards');
  $('#staffAuditTable')?.classList.toggle('hidden', state.staffAuditView !== 'table');
  $('#staffAuditTableHead')?.classList.toggle('hidden', state.staffAuditView !== 'table');
  $$('.staff-audit-view-toggle button[data-audit-view]').forEach((button) => {
    const active = button.dataset.auditView === state.staffAuditView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function bindStaffAuditViewToggle() {
  const toolbar = document.querySelector('.staff-audit-view-toggle');
  if (!toolbar || toolbar.dataset.bound) return;
  toolbar.dataset.bound = '1';
  toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-audit-view]');
    if (!button) return;
    setStaffAuditView(button.dataset.auditView);
  });
}

function renderStaffAuditFilter(selectedDate) {
  const filter = $('#staffAuditFilter');
  if (!filter) return;
  const date = selectedDate || state.staffAuditDate || todayInputDate();
  state.staffAuditDate = date;
  if (filter.dataset.bound === '1') {
    const dateInput = $('#staffAuditDateInput');
    const searchInput = $('#staffAuditSearchInput');
    const hint = filter.querySelector('small');
    if (dateInput) dateInput.value = date;
    if (searchInput) searchInput.value = state.staffAuditSearchQuery || '';
    if (hint) hint.textContent = `Seçilen gün: ${formatFilterDateLabel(date)} · Mesaj metrikleri bu güne göre filtrelenir; panel aktivitesi canlıdır.`;
    return;
  }
  filter.dataset.bound = '1';
  filter.innerHTML = `
    <label class="staff-date-filter">
      <span>Tarih filtresi</span>
      <input type="date" id="staffAuditDateInput" value="${escapeHtml(date)}">
    </label>
    <label class="panel-search">
      <span>Personel ara</span>
      <input type="search" id="staffAuditSearchInput" value="${escapeHtml(state.staffAuditSearchQuery || '')}" placeholder="Ad veya kullanıcı adı..." autocomplete="off">
    </label>
    <small>Seçilen gün: ${escapeHtml(formatFilterDateLabel(date))} · Mesaj metrikleri bu güne göre filtrelenir; panel aktivitesi canlıdır.</small>`;
  const dateInput = $('#staffAuditDateInput');
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      state.staffAuditDate = dateInput.value;
      loadStaffAudit();
    });
  }
  const searchInput = $('#staffAuditSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.staffAuditSearchQuery = searchInput.value;
      renderStaffAuditViews();
    });
  }
}

function renderStaffAuditViews() {
  const audit = staffAuditForDisplay();
  if (!audit) return;
  renderStaffAuditSummary(state.staffAuditData, audit);
  renderStaffAuditCards(audit);
  renderStaffAuditTable(audit);
  updateStaffAuditAwayTimes();
}

// Personel denetim raporunu yükler ve çizer (admin/yönetici).
async function loadStaffAudit() {
  try {
    const query = state.staffAuditDate || todayInputDate();
    const data = await api(`/api/reports/staff-audit?date=${encodeURIComponent(query)}`);
    const audit = data.audit;
    state.staffAuditData = audit;
    state.staffAuditLoadedAt = Date.parse(audit.generatedAt) || Date.now();
    renderStaffAuditFilter(audit.date);
    renderStaffAuditViews();
    bindStaffAuditViewToggle();
    setStaffAuditView(state.staffAuditView || 'cards');
    startStaffAuditTicker();
  } catch (error) {
    flashError(error);
  }
}

// Milisaniye süreyi okunur biçime çevirir (denetim raporu için).
function formatDuration(ms) {
  if (ms === null || ms === undefined) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} sn`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} dk ${seconds % 60} sn`;
  const hours = Math.floor(minutes / 60);
  return `${hours} sa ${minutes % 60} dk`;
}

function formatDateTime(value) {
  try { return new Date(value).toLocaleString('tr-TR'); } catch { return String(value); }
}

function renderTemplates() {
  // Şablon ekleme formu yalnızca admin'e gösterilir; diğer roller salt görüntüler.
  const form = $('#templateForm');
  if (form) form.classList.toggle('hidden', !canManageTemplates());
  $('#templateList').innerHTML = state.templates.map((template) => `
    <div class="item ${template.active === false ? 'inactive' : ''}">
      <h3>${escapeHtml(template.title)} ${template.active === false ? '<span class="badge">Pasif</span>' : ''}</h3>
      <p>${escapeHtml(template.body)}</p>
      <small>${safeDepartmentName(template.departmentId)}</small>
      ${canManageTemplates() ? `
      <div class="item-actions">
        <button type="button" class="secondary" onclick="editTemplate('${template.id}')">Düzenle</button>
        <button type="button" class="danger" onclick="removeTemplate('${template.id}')">Sil</button>
      </div>` : ''}
    </div>
  `).join('');
}

function openTemplateModal(id) {
  const template = state.templates.find((item) => item.id === id);
  if (!template) return;
  $('#templateEditId').value = template.id;
  $('#templateEditTitle').value = template.title || '';
  $('#templateEditBody').value = template.body || '';
  $('#templateEditMeta').value = template.metaTemplateName || '';
  $('#templateEditLang').value = template.language || 'tr';
  $('#templateEditModal')?.classList.remove('hidden');
}

function closeTemplateModal() {
  $('#templateEditModal')?.classList.add('hidden');
  $('#templateEditForm')?.reset();
}

async function editTemplate(id) {
  openTemplateModal(id);
}

async function removeTemplate(id) {
  const template = state.templates.find((item) => item.id === id);
  if (!(await confirmAction(`"${template?.title || 'Şablon'}" silinsin mi?`))) return;
  try {
    await api(`/api/templates/${id}`, { method: 'DELETE' });
    flash('Şablon silindi');
    await refreshAll();
  } catch (error) {
    flashError(error);
  }
}

function renderAccounts() {
  if (isStaff()) {
    const accounts = visibleChatAccounts();
    $('#accountList').innerHTML = accounts.map((account, index) => `
      <div class="account-card ${account.status} staff-account-card">
        <div class="account-card-head">
          <div>
            <span class="eyebrow-dark">Kayıtlı numara</span>
            <h3>${escapeHtml(accountDisplayName(account, index))}</h3>
            <p>${escapeHtml(account.phoneNumber || '-')}</p>
          </div>
          <span class="status-pill ${account.status}">${accountStatusText(account.status)}</span>
        </div>
        <p class="account-reason">Mesajlaşmak için <strong>Canlı Sohbet</strong> sekmesinden bu hattı seçin.</p>
      </div>
    `).join('') || '<div class="item">Henüz numara eklemediniz. Yukarıdan telefon numaranızı yazıp <strong>Numara ekle</strong> deyin.</div>';
    return;
  }
  if (isDepartmentSupervisor()) {
    const accounts = departmentStaffAccounts();
    $('#accountList').innerHTML = accounts.map((account, index) => {
      const owner = state.users.find((user) => user.id === account.userId);
      return `
      <div class="account-card ${account.status} staff-account-card">
        <div class="account-card-head">
          <div>
            <span class="eyebrow-dark">${escapeHtml(owner?.fullName || 'Personel')}</span>
            <h3>${escapeHtml(accountDisplayName(account, index))}</h3>
            <p>${escapeHtml(account.phoneNumber || '-')}</p>
          </div>
          <span class="status-pill ${account.status}">${accountStatusText(account.status)}</span>
        </div>
        <p class="account-reason">Mesajlaşmak için <strong>Canlı Sohbet</strong> sekmesinden bu hattı seçin.</p>
      </div>`;
    }).join('') || '<div class="item">Departmanınızda bağlı WhatsApp hesabı bulunmuyor.</div>';
    return;
  }
  $('#accountList').innerHTML = state.accounts.map((account) => {
    const owner = state.users.find((user) => user.id === account.userId);
    return `
    <div class="account-card ${account.status}">
      <div class="account-card-head">
        <div>
          <span class="eyebrow-dark">Personel hattı</span>
          <h3>${escapeHtml(account.label)}</h3>
          <p>${escapeHtml(account.phoneNumber || 'Telefon numarası yok')}</p>
        </div>
        <span class="status-pill ${account.status}">${accountStatusText(account.status)}</span>
      </div>
      <div class="connection-steps">
        ${renderConnectionStep('1', 'Numara kaydı', Boolean(account.phoneNumber))}
        ${renderConnectionStep('2', 'Meta doğrulama', ['connected', 'connecting'].includes(account.status))}
        ${renderConnectionStep('3', 'Bağlantı aktif', account.status === 'connected')}
      </div>
      <p class="account-reason">${escapeHtml(account.statusReason || '')}</p>
      <div class="account-meta">
        <span>Sahip: ${escapeHtml(owner?.fullName || '')}</span>
        <span>Sağlık: ${escapeHtml(account.connectionHealth || '-')}</span>
        ${account.lastHeartbeatAt ? `<span>Son kontrol: ${formatDateTime(account.lastHeartbeatAt)}</span>` : ''}
      </div>
      <div class="account-actions">
        <button type="button" class="secondary" onclick="editAccount('${account.id}')">Düzenle</button>
        <button type="button" onclick="checkAccountHealth('${account.id}')">Bağlantıyı kontrol et</button>
        <button type="button" class="secondary" onclick="disconnectAccount('${account.id}')">Bağlantıyı kes</button>
        <button type="button" class="danger" onclick="deleteAccount('${account.id}')">Hesabı sil</button>
      </div>
    </div>`;
  }).join('');
}

function openAccountModal(id) {
  if (!canManageAccounts()) {
    flashError(new Error('Personel hesap bilgilerini düzenleyemez'));
    return;
  }
  const account = state.accounts.find((item) => item.id === id);
  if (!account) return;
  $('#accountEditId').value = account.id;
  $('#accountEditLabel').value = account.label || '';
  $('#accountEditPhone').value = account.phoneNumber || '';
  $('#accountEditCloudId').value = account.cloudPhoneNumberId || '';
  $('#accountEditModal')?.classList.remove('hidden');
}

function closeAccountModal() {
  $('#accountEditModal')?.classList.add('hidden');
  $('#accountEditForm')?.reset();
}

async function editAccount(id) {
  openAccountModal(id);
}

function openDepartmentModal(id) {
  const department = state.departments.find((item) => item.id === id);
  if (!department) return;
  $('#departmentEditId').value = department.id;
  $('#departmentEditName').value = department.name || '';
  $('#departmentEditActive').checked = department.active !== false;
  $('#departmentEditModal')?.classList.remove('hidden');
}

function closeDepartmentModal() {
  $('#departmentEditModal')?.classList.add('hidden');
  $('#departmentEditForm')?.reset();
}

async function removeDepartment(departmentId) {
  if (!isAdmin()) {
    flashError(new Error('Departman silme yetkiniz yok'));
    return;
  }
  const department = state.departments.find((item) => item.id === departmentId);
  if (!department) {
    flashError(new Error('Departman bulunamadı'));
    return;
  }
  const members = state.users.filter((user) => (
    user.departmentId === departmentId
    && (user.role === 'staff' || user.role === 'manager' || user.role === 'auditor')
  ));
  const admins = state.users.filter((user) => user.departmentId === departmentId && user.role === 'admin');
  if (admins.length) {
    flashError(new Error('Departmanda admin kullanıcısı var. Silmeden önce başka departmana taşıyın.'));
    return;
  }
  const memberLabel = members.length
    ? `${members.length} kullanıcı (personel, yönetici, denetçi) ve ilişkili verileri`
    : 'ilişkili şablon ve kayıtları';
  const confirmed = await confirmAction(
    `"${department.name}" departmanı kalıcı olarak silinecek. `
    + `Bu işlem ${memberLabel} tamamen kaldırır. Geri alınamaz. Devam edilsin mi?`
  );
  if (!confirmed) return;
  try {
    const result = await api(`/api/departments/${encodeURIComponent(departmentId)}`, { method: 'DELETE' });
    if (result.deleted !== true) {
      throw new Error(result.error || 'Departman kalıcı olarak silinemedi');
    }
    state.departments = state.departments.filter((item) => item.id !== departmentId);
    state.users = state.users.filter((user) => user.departmentId !== departmentId || user.role === 'admin');
    await refreshAll();
    flash(result.message || 'Departman kalıcı olarak silindi');
  } catch (error) {
    flashError(error);
  }
}

async function exportManagedUser(userId) {
  try {
    const data = await api(`/api/users/${userId}/export`);
    const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `user-export-${userId}.json`;
    link.click();
    URL.revokeObjectURL(url);
    flash('Kullanıcı verisi dışa aktarıldı');
  } catch (error) {
    flashError(error);
  }
}

async function restoreFromBackup() {
  if (!(await confirmAction('Son yedekten geri yüklemek istediğinize emin misiniz? Mevcut verinin üzerine yazılır.'))) return;
  try {
    await api('/api/admin/restore-backup', { method: 'POST' });
    await refreshAll();
    flash('Yedekten geri yükleme tamamlandı');
  } catch (error) {
    flashError(error);
  }
}

async function deleteAccount(id) {
  const account = state.accounts.find((item) => item.id === id);
  if (!(await confirmAction(`"${account?.label || 'Hesap'}" silinsin mi?`))) return;
  try {
    await api(`/api/accounts/${id}`, { method: 'DELETE' });
    flash('Hesap silindi');
    await refreshAll();
  } catch (error) {
    flashError(error);
  }
}

function accountStatusText(status) {
  return {
    creating: 'Hazırlanıyor',
    connecting: 'Doğrulanıyor',
    connected: 'Bağlı',
    disconnected: 'Bağlantı kesildi',
    deleted: 'Silindi'
  }[status] || status;
}

function renderConnectionStep(number, label, active) {
  return `<div class="connection-step ${active ? 'active' : ''}"><strong>${number}</strong><span>${label}</span></div>`;
}

// --- Sohbet görünümü yardımcıları ---
function initialsOf(name) {
  const text = String(name || '').trim();
  if (!text) return '#';
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    const part = parts[0];
    return (/^\d+$/.test(part) ? part.slice(-2) : part.slice(0, 2)).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function formatChatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Dün';
  return date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
}

function formatTimeShort(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Bugün';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Dün';
  return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function statusTick(message) {
  if (message.direction !== 'out') return '';
  if (message.status === 'failed') return '<span class="tick failed">!</span>';
  const isRead = message.status === 'read';
  const isSingle = message.status === 'pending' || message.status === 'sent';
  return `<span class="tick${isRead ? ' read' : ''}">${isSingle ? '✓' : '✓✓'}</span>`;
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// Bir mesajın medya içeriğini (resim/video/ses/dosya) baloncuk içinde üretir.
function renderMediaHtml(message) {
  if (!message.mediaType) return '';
  const src = `/api/media/${message.id}`;
  if (message.mediaType === 'image') {
    return `<a class="media-image" href="${src}" target="_blank" rel="noopener">`
      + `<img src="${src}" alt="Fotoğraf" loading="lazy"></a>`;
  }
  if (message.mediaType === 'video') {
    return `<video class="media-video" src="${src}" controls preload="metadata"></video>`;
  }
  if (message.mediaType === 'audio') {
    return `<audio class="media-audio" src="${src}" controls preload="metadata"></audio>`;
  }
  const name = message.fileName || 'Dosya';
  return `<a class="media-doc" href="${src}" target="_blank" rel="noopener" download="${escapeHtml(name)}">`
    + '<span class="media-doc-icon">📄</span>'
    + '<span class="media-doc-info">'
    + `<span class="media-doc-name">${escapeHtml(name)}</span>`
    + `<span class="media-doc-size">${escapeHtml(formatFileSize(message.mediaSize))}</span>`
    + '</span></a>';
}

function renderMessagesHtml(messages) {
  if (!messages.length) return '<div class="chat-empty">Bu sohbette henüz mesaj yok.</div>';
  let html = '';
  let lastDay = '';
  let lastDirection = '';
  messages.forEach((message) => {
    const dayKey = new Date(message.createdAt).toDateString();
    if (dayKey !== lastDay) {
      html += `<div class="date-sep">${escapeHtml(formatDayLabel(message.createdAt))}</div>`;
      lastDay = dayKey;
      lastDirection = '';
    }
    const groupStart = message.direction !== lastDirection ? ' group-start' : '';
    lastDirection = message.direction;
    const media = renderMediaHtml(message);
    const hasMedia = media ? ' has-media' : '';
    const text = message.text
      ? `<span class="message-text">${escapeHtml(message.text)}</span>`
      : '';
    let audit = '';
    if (message.direction === 'out' && message.senderUserId) {
      audit = `<span class="message-audit">${escapeHtml(userName(message.senderUserId))}</span>`;
    } else if (message.direction === 'in') {
      const parts = [];
      if (message.seenByUserId) {
        parts.push(`görüldü: ${userName(message.seenByUserId)} · ${formatTimeShort(message.seenAt)}`);
      }
      if (message.respondedByUserId) {
        parts.push(`yanıt: ${userName(message.respondedByUserId)} · ${formatTimeShort(message.respondedAt)}`);
      }
      if (parts.length) audit = `<span class="message-audit">${escapeHtml(parts.join(' · '))}</span>`;
    }
    const hideBtn = canHideMessages() && !message.hidden
      ? `<button type="button" class="ghost mini message-hide-btn" onclick="hideChatMessage('${message.id}')">Gizle</button>`
      : '';
    html += `<div class="message ${message.direction}${groupStart}${hasMedia}">`
      + media
      + text
      + audit
      + `<span class="message-meta">${formatTimeShort(message.createdAt)}${statusTick(message)}${hideBtn}</span>`
      + '</div>';
  });
  return html;
}

function scrollMessagesToBottom(element) {
  if (!element) return;
  const go = () => { element.scrollTop = element.scrollHeight; };
  go();
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  setTimeout(go, 80);
}

function renderConversations() {
  const filter = $('#chatAccountFilter').value || state.selectedChatAccountId;
  const conversations = state.conversations
    .filter((conversation) => !filter || conversation.accountId === filter)
    .slice()
    .sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')));
  const activeId = state.currentConversation?.id;
  $('#conversationList').innerHTML = conversations.map((conversation) => {
    const name = conversation.customerName || conversation.customerPhone;
    const last = conversation.lastMessage;
    const mediaLabel = { image: '📷 Fotoğraf', video: '🎬 Video', audio: '🎤 Ses', document: '📄 Dosya' };
    const previewText = last?.text || (last?.mediaType ? mediaLabel[last.mediaType] || '📎 Medya' : 'Henüz mesaj yok');
    const outTick = last?.direction === 'out' ? statusTick(last) : '';
    const time = formatChatTime(conversation.lastMessageAt || last?.createdAt);
    const isActive = conversation.id === activeId;
    const unread = conversation.unreadCount || 0;
    const unreadBadge = unread > 0 ? `<span class="chat-unread">${unread > 99 ? '99+' : unread}</span>` : '';
    const classes = `${isActive ? 'active' : ''}${unread > 0 ? ' has-unread' : ''}`.trim();
    return `
    <button class="${classes}" onclick="selectConversation('${conversation.id}')">
      <span class="chat-avatar"><span class="avatar-initials">${escapeHtml(initialsOf(name))}</span></span>
      <span class="chat-top">
        <span class="chat-name">${escapeHtml(name)}</span>
        <span class="chat-time">${escapeHtml(time)}</span>
      </span>
      <span class="chat-preview">${outTick}<span class="chat-preview-text">${escapeHtml(previewText)}</span>${unreadBadge}</span>
    </button>`;
  }).join('') || '<div class="chat-empty">Bu hesapta sohbet bulunmuyor.</div>';
}

async function selectConversation(id) {
  state.currentConversation = state.conversations.find((conversation) => conversation.id === id);
  if (!state.currentConversation) return;
  // Sayfa yenilemesinde açık sohbete geri dönebilmek için sakla.
  try { localStorage.setItem('wp.activeConversationId', id); } catch { /* storage kapalı olabilir */ }
  const title = state.currentConversation.customerName || state.currentConversation.customerPhone;
  const header = $('#conversationHeader');
  header.classList.remove('empty');
  header.innerHTML = `
    <span class="conv-avatar"><span class="avatar-initials">${escapeHtml(initialsOf(title))}</span></span>
    <span class="conv-info">
      <span class="conv-name">${escapeHtml(title)}</span>
      <span class="conv-sub">${escapeHtml(state.currentConversation.customerPhone)}</span>
    </span>`;
  $('#customerPhone').value = state.currentConversation.customerPhone;
  state.selectedChatAccountId = state.currentConversation.accountId;
  $('#chatAccountFilter').value = state.currentConversation.accountId;
  await loadMessages(id);
  await markConversationRead(id);
  applyWindowNotice(state.currentConversation);
  renderChatAccountStrip();
  renderConversations();
}

function refreshComposerState() {
  const notice = $('#windowNotice');
  const input = $('#messageText');
  const attachBtn = $('#attachBtn');
  const sendBtn = $('#sendBtn');
  const templateSelect = $('#templateSelect');
  const phoneInput = $('#customerPhone');
  if (!notice) return;

  refreshTemplateSelect();
  const templateOnly = isTemplateOnlyMode();
  const hasPhone = Boolean(phoneInput?.value?.trim());
  const hasAccount = Boolean(state.currentConversation?.accountId || state.selectedChatAccountId || $('#chatAccountFilter')?.value);
  const selectedTemplate = state.templates.find((item) => item.id === templateSelect?.value);
  const templateReady = Boolean(selectedTemplate?.metaTemplateName);

  if (templateOnly) {
    const isNewContact = !state.currentConversation && hasPhone;
    const sendableCount = activeTemplates().filter((template) => template.metaTemplateName).length;
    const baseNotice = isNewContact
      ? 'İlk mesaj Cloud API kuralı gereği onaylı şablon ile gönderilmelidir. Müşteri yanıt verince manuel mesaj açılır.'
      : '24 saatlik yanıt penceresi kapalı — onaylı şablon seçin. Müşteri yanıt verince serbest mesajlaşma yeniden açılır.';
    notice.textContent = sendableCount
      ? baseNotice
      : `${baseNotice} Şablonlar listede görünür; göndermek için adminin Meta onaylı şablon adı (metaTemplateName) tanımlaması gerekir.`;
    notice.classList.remove('hidden');
    if (input) {
      input.disabled = true;
      input.placeholder = 'Şablon seçin — manuel mesaj bu aşamada kapalı';
    }
    if (attachBtn) attachBtn.disabled = true;
    if (templateSelect) templateSelect.disabled = false;
    if (sendBtn) sendBtn.disabled = !hasAccount || !hasPhone || !templateReady;
  } else if (!hasPhone) {
    notice.textContent = 'Mesaj göndermek için alıcı telefon numarası girin veya listeden sohbet seçin.';
    notice.classList.remove('hidden');
    if (input) {
      input.disabled = true;
      input.placeholder = 'Önce sohbet veya telefon numarası seçin';
    }
    if (attachBtn) attachBtn.disabled = true;
    if (templateSelect) templateSelect.disabled = false;
    if (sendBtn) sendBtn.disabled = true;
  } else {
    notice.classList.add('hidden');
    if (input) {
      input.disabled = false;
      input.placeholder = 'Manuel mesaj yaz';
    }
    if (attachBtn) attachBtn.disabled = !state.currentConversation;
    if (templateSelect) templateSelect.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

function applyWindowNotice(conversation) {
  if (conversation) state.currentConversation = conversation;
  refreshComposerState();
}

// Sohbeti sunucuda okundu işaretler ve yerel sayaçları sıfırlar (rozet temizlenir).
async function markConversationRead(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation || !conversation.unreadCount) return;
  try {
    await api(`/api/conversations/${id}/read`, { method: 'POST' });
    conversation.unreadCount = 0;
  } catch {
    // Sessizce yut: okundu işaretleme başarısız olsa da sohbet açık kalır.
  }
}

async function loadMessages(id, { before, prepend = false } = {}) {
  const limit = 80;
  const query = before
    ? `?limit=${limit}&before=${encodeURIComponent(before)}`
    : `?limit=${limit}`;
  const data = await api(`/api/conversations/${id}/messages${query}`);
  state.messages = prepend ? [...data.messages, ...state.messages] : data.messages;
  state.messagesHasMore = data.messages.length >= limit;
  const target = $('#messageList');
  const olderBtn = state.messagesHasMore && state.messages.length
    ? `<button type="button" class="ghost load-older-messages" id="loadOlderMessages">Daha eski mesajları yükle</button>`
    : '';
  target.innerHTML = olderBtn + renderMessagesHtml(state.messages);
  $('#loadOlderMessages')?.addEventListener('click', async () => {
    const first = state.messages[0];
    if (!first) return;
    await loadMessages(id, { before: first.createdAt, prepend: true });
  });
  if (!prepend) scrollMessagesToBottom(target);
}

async function hideChatMessage(messageId) {
  const ok = await confirmAction('Bu mesaj panelde gizlensin mi?');
  if (!ok) return;
  try {
    await api(`/api/messages/${messageId}/hide`, { method: 'POST' });
    if (state.currentConversation) await loadMessages(state.currentConversation.id);
    await refreshIncremental();
    flash('Mesaj gizlendi');
  } catch (error) {
    flashError(error);
  }
}

const AUDIT_ACTION_LABELS = {
  'auth.login': 'Giriş',
  'auth.logout': 'Çıkış',
  'user.create': 'Kullanıcı oluşturma',
  'user.update': 'Kullanıcı güncelleme',
  'user.delete': 'Kullanıcı silme',
  'user.data.erase': 'KVKK veri silme',
  'department.create': 'Departman oluşturma',
  'department.update': 'Departman güncelleme',
  'department.delete': 'Departman silme',
  'template.create': 'Şablon oluşturma',
  'template.update': 'Şablon güncelleme',
  'template.delete': 'Şablon silme',
  'account.create': 'Hesap oluşturma',
  'account.update': 'Hesap güncelleme',
  'account.delete': 'Hesap silme',
  'account.disconnect': 'Hesap bağlantı kesme',
  'message.send': 'Mesaj gönderme',
  'message.send.media': 'Medya gönderme',
  'message.hide': 'Mesaj gizleme',

  'settings.cloudapi.update': 'Cloud API ayarı',
  'store.restore': 'Yedekten geri yükleme'
};

const AUDIT_ENTITY_LABELS = {
  user: 'Kullanıcı',
  department: 'Departman',
  template: 'Şablon',
  whatsappAccount: 'WhatsApp hesabı',
  message: 'Mesaj',
  panelSettings: 'Panel ayarı',
  error: 'Hata'
};

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action || '-';
}

function auditEntityLabel(entity) {
  return AUDIT_ENTITY_LABELS[entity] || entity || '-';
}

function formatAuditMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return '-';
  const parts = [];
  if (metadata.username) parts.push(`@${metadata.username}`);
  if (metadata.fullName) parts.push(metadata.fullName);
  if (metadata.name) parts.push(metadata.name);
  if (metadata.role) parts.push(roleName(metadata.role));
  if (Array.isArray(metadata.removedUsers)) parts.push(`${metadata.removedUsers.length} kullanıcı silindi`);
  if (metadata.message) parts.push(String(metadata.message));
  if (metadata.restoredFrom) parts.push(`Kaynak: ${metadata.restoredFrom}`);
  if (parts.length) return parts.join(' · ');
  const text = JSON.stringify(metadata);
  if (!text || text === '{}') return '-';
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function auditLogsForDisplay() {
  let logs = [...(state.auditLogs || [])];
  const q = normalizeSearchQuery(state.auditLogSearchQuery);
  if (q) {
    logs = logs.filter((log) => {
      const haystack = [
        log.actorName,
        log.action,
        auditActionLabel(log.action),
        log.entity,
        auditEntityLabel(log.entity),
        log.entityId,
        formatAuditMetadata(log.metadata)
      ].join(' ').toLocaleLowerCase('tr-TR');
      return haystack.includes(q);
    });
  }
  if (state.auditLogActionFilter) {
    logs = logs.filter((log) => log.action === state.auditLogActionFilter);
  }
  if (state.auditLogEntityFilter) {
    logs = logs.filter((log) => log.entity === state.auditLogEntityFilter);
  }
  if (state.auditLogDateFrom) {
    const from = new Date(`${state.auditLogDateFrom}T00:00:00`);
    logs = logs.filter((log) => !Number.isNaN(from.getTime()) && new Date(log.createdAt) >= from);
  }
  if (state.auditLogDateTo) {
    const to = new Date(`${state.auditLogDateTo}T23:59:59.999`);
    logs = logs.filter((log) => !Number.isNaN(to.getTime()) && new Date(log.createdAt) <= to);
  }
  const key = state.auditLogSortKey || 'createdAt';
  const dir = state.auditLogSortDir === 'asc' ? 1 : -1;
  logs.sort((a, b) => {
    if (key === 'actorName') {
      return (a.actorName || '').localeCompare(b.actorName || '', 'tr') * dir;
    }
    if (key === 'action') {
      return auditActionLabel(a.action).localeCompare(auditActionLabel(b.action), 'tr') * dir;
    }
    if (key === 'entity') {
      return auditEntityLabel(a.entity).localeCompare(auditEntityLabel(b.entity), 'tr') * dir;
    }
    return (Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)) * dir;
  });
  return logs;
}

function auditLogSortIndicator(key) {
  if (state.auditLogSortKey !== key) return '';
  return state.auditLogSortDir === 'asc' ? ' ▲' : ' ▼';
}

function syncAuditLogFilterOptions() {
  const actionSelect = $('#auditLogActionFilter');
  const entitySelect = $('#auditLogEntityFilter');
  if (!actionSelect || !entitySelect) return;
  const actions = [...new Set((state.auditLogs || []).map((log) => log.action).filter(Boolean))].sort();
  const entities = [...new Set((state.auditLogs || []).map((log) => log.entity).filter(Boolean))].sort();
  actionSelect.innerHTML = [
    '<option value="">Tüm işlemler</option>',
    ...actions.map((action) => `<option value="${escapeHtml(action)}">${escapeHtml(auditActionLabel(action))}</option>`)
  ].join('');
  entitySelect.innerHTML = [
    '<option value="">Tüm varlıklar</option>',
    ...entities.map((entity) => `<option value="${escapeHtml(entity)}">${escapeHtml(auditEntityLabel(entity))}</option>`)
  ].join('');
  actionSelect.value = state.auditLogActionFilter || '';
  entitySelect.value = state.auditLogEntityFilter || '';
}

function renderAuditLogFilter() {
  const filter = $('#auditLogFilter');
  if (!filter) return;
  if (filter.dataset.bound !== '1') {
    filter.dataset.bound = '1';
    filter.innerHTML = `
      <label class="panel-search">
        <span>Ara</span>
        <input type="search" id="auditLogSearchInput" placeholder="Kullanıcı, işlem, varlık veya detay..." autocomplete="off">
      </label>
      <label class="audit-log-select">
        <span>İşlem</span>
        <select id="auditLogActionFilter"></select>
      </label>
      <label class="audit-log-select">
        <span>Varlık</span>
        <select id="auditLogEntityFilter"></select>
      </label>
      <label class="staff-date-filter">
        <span>Başlangıç</span>
        <input type="date" id="auditLogDateFrom">
      </label>
      <label class="staff-date-filter">
        <span>Bitiş</span>
        <input type="date" id="auditLogDateTo">
      </label>
      <button type="button" class="secondary" id="auditLogClearFilters">Filtreleri temizle</button>
      <small id="auditLogScopeHint">Sütun başlıklarına tıklayarak sıralayın.</small>`;
    $('#auditLogSearchInput')?.addEventListener('input', (event) => {
      state.auditLogSearchQuery = event.currentTarget.value;
      renderAuditLogViews();
    });
    $('#auditLogActionFilter')?.addEventListener('change', (event) => {
      state.auditLogActionFilter = event.currentTarget.value;
      renderAuditLogViews();
    });
    $('#auditLogEntityFilter')?.addEventListener('change', (event) => {
      state.auditLogEntityFilter = event.currentTarget.value;
      renderAuditLogViews();
    });
    $('#auditLogDateFrom')?.addEventListener('change', (event) => {
      state.auditLogDateFrom = event.currentTarget.value;
      renderAuditLogViews();
    });
    $('#auditLogDateTo')?.addEventListener('change', (event) => {
      state.auditLogDateTo = event.currentTarget.value;
      renderAuditLogViews();
    });
    $('#auditLogClearFilters')?.addEventListener('click', () => {
      state.auditLogSearchQuery = '';
      state.auditLogActionFilter = '';
      state.auditLogEntityFilter = '';
      state.auditLogDateFrom = '';
      state.auditLogDateTo = '';
      state.auditLogSortKey = 'createdAt';
      state.auditLogSortDir = 'desc';
      const searchInput = $('#auditLogSearchInput');
      const dateFrom = $('#auditLogDateFrom');
      const dateTo = $('#auditLogDateTo');
      if (searchInput) searchInput.value = '';
      if (dateFrom) dateFrom.value = '';
      if (dateTo) dateTo.value = '';
      syncAuditLogFilterOptions();
      renderAuditLogViews();
    });
  }
  const searchInput = $('#auditLogSearchInput');
  const dateFrom = $('#auditLogDateFrom');
  const dateTo = $('#auditLogDateTo');
  if (searchInput) searchInput.value = state.auditLogSearchQuery || '';
  if (dateFrom) dateFrom.value = state.auditLogDateFrom || '';
  if (dateTo) dateTo.value = state.auditLogDateTo || '';
  const scopeHint = $('#auditLogScopeHint');
  if (scopeHint) {
    scopeHint.textContent = isManager()
      ? `${departmentName(state.me?.departmentId)} departmanına ait kayıtlar gösteriliyor. Sütun başlıklarına tıklayarak sıralayın.`
      : 'Sütun başlıklarına tıklayarak sıralayın.';
  }
  syncAuditLogFilterOptions();
}

function renderAuditLogTable() {
  const wrap = $('#auditLogTable');
  const meta = $('#auditLogMeta');
  if (!wrap) return;
  const logs = auditLogsForDisplay();
  const total = state.auditLogs?.length || 0;
  if (meta) {
    meta.textContent = total
      ? (logs.length === total
        ? `${total} kayıt`
        : `${logs.length} / ${total} kayıt gösteriliyor`)
      : 'Kayıt yok';
  }
  const rows = logs.map((log) => `
    <tr>
      <td data-label="Tarih">${escapeHtml(formatDateTime(log.createdAt))}</td>
      <td data-label="Kullanıcı">${escapeHtml(log.actorName || 'Sistem')}</td>
      <td data-label="İşlem"><span class="audit-log-action">${escapeHtml(auditActionLabel(log.action))}</span></td>
      <td data-label="Varlık">${escapeHtml(auditEntityLabel(log.entity))}</td>
      <td data-label="Kayıt ID"><code class="audit-log-id">${escapeHtml(log.entityId || '-')}</code></td>
      <td data-label="Detay">${escapeHtml(formatAuditMetadata(log.metadata))}</td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div class="audit-log-table-scroll">
      <table class="audit-log-table staff-audit-table">
        <thead>
          <tr class="staff-audit-group-row">
            <th><button type="button" class="audit-sort-btn" data-sort="createdAt">Tarih${auditLogSortIndicator('createdAt')}</button></th>
            <th><button type="button" class="audit-sort-btn" data-sort="actorName">Kullanıcı${auditLogSortIndicator('actorName')}</button></th>
            <th><button type="button" class="audit-sort-btn" data-sort="action">İşlem${auditLogSortIndicator('action')}</button></th>
            <th><button type="button" class="audit-sort-btn" data-sort="entity">Varlık${auditLogSortIndicator('entity')}</button></th>
            <th>Kayıt ID</th>
            <th>Detay</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="6">${total ? 'Filtreye uygun kayıt bulunamadı.' : 'Kayıt yok'}</td></tr>`}</tbody>
      </table>
    </div>`;
  wrap.querySelectorAll('[data-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      if (state.auditLogSortKey === key) {
        state.auditLogSortDir = state.auditLogSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.auditLogSortKey = key;
        state.auditLogSortDir = key === 'createdAt' ? 'desc' : 'asc';
      }
      renderAuditLogViews();
    });
  });
}

function renderAuditLogViews() {
  renderAuditLogTable();
}

async function loadAuditLogs() {
  try {
    const data = await api('/api/audit-logs?limit=500');
    state.auditLogs = data.logs || [];
    renderAuditLogFilter();
    renderAuditLogViews();
  } catch (error) {
    flashError(error);
  }
}

function confirmAction(message) {
  return new Promise((resolve) => {
    const modal = $('#confirmModal');
    const text = $('#confirmModalText');
    if (!modal || !text) {
      resolve(window.confirm(message));
      return;
    }
    text.textContent = message;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    const okButton = $('#confirmModalOk');
    const cancelButton = $('#confirmModalCancel');
    const backdrop = $('#confirmModalBackdrop');
    const onKeyDown = (event) => {
      if (event.key === 'Escape') cleanup(false);
    };
    const cleanup = (result) => {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      okButton?.removeEventListener('click', onOk);
      cancelButton?.removeEventListener('click', onCancel);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeyDown);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okButton?.addEventListener('click', onOk, { once: true });
    cancelButton?.addEventListener('click', onCancel, { once: true });
    backdrop?.addEventListener('click', onCancel, { once: true });
    document.addEventListener('keydown', onKeyDown);
    okButton?.focus();
  });
}

function switchView(view, options = {}) {
  $$('.view').forEach((element) => element.classList.add('hidden'));
  const target = $(`#${view}`);
  if (!target) return;
  target.classList.remove('hidden');
  $$('nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const navButton = document.querySelector(`nav button[data-view="${view}"]`);
  if (navButton) $('#viewTitle').textContent = navButton.textContent;
  if (view === 'staffAudit') loadStaffAudit();
  else stopStaffAuditTicker();
  if (view === 'auditLogs') loadAuditLogs();
  if (view === 'cloudApi') loadCloudApiSettings();
  if (view === 'chat') refreshComposerState();
  // Sayfa yenilemesinde son görünümden devam edebilmek için sakla.
  if (options.persist !== false) {
    try { localStorage.setItem('wp.activeView', view); } catch { /* storage kapalı olabilir */ }
  }
}

function serializeForm(form) {
  return Object.fromEntries(new FormData(form).entries());
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

async function checkAccountHealth(id) {
  try {
    await api(`/api/accounts/${id}/health`, { method: 'POST' });
    flash('Bağlantı sağlıklı');
    await refreshAll();
  } catch (error) {
    flashError(error);
  }
}

function renderTemplateVariables(templateId) {
  const container = $('#templateVariables');
  if (!container) return;
  const template = state.templates.find((item) => item.id === templateId);
  const placeholders = template ? [...String(template.body).matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()) : [];
  if (!placeholders.length) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = placeholders.map((key) => `
    <label>${escapeHtml(key)}
      <input type="text" data-template-var="${escapeHtml(key)}" placeholder="${escapeHtml(key)}">
    </label>`).join('');
}

function collectTemplateVariables() {
  const values = {};
  document.querySelectorAll('[data-template-var]').forEach((input) => {
    values[input.dataset.templateVar] = input.value;
  });
  return values;
}

async function sendMediaFile(file, caption) {
  if (!state.currentConversation) {
    throw new Error('Önce bir sohbet seçin');
  }
  const toBase64 = (value) => btoa(unescape(encodeURIComponent(value || '')));
  const response = await fetch(`/api/conversations/${state.currentConversation.id}/media`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-mime-type': file.type || 'application/octet-stream',
      'x-file-name': toBase64(file.name),
      'x-caption': toBase64(caption)
    },
    body: file
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Dosya gönderilemedi');
  return data;
}

function clearMediaSelection() {
  state.pendingMedia = null;
  if (state.pendingMediaUrl) {
    URL.revokeObjectURL(state.pendingMediaUrl);
    state.pendingMediaUrl = null;
  }
  $('#mediaInput').value = '';
  const preview = $('#mediaPreview');
  preview.innerHTML = '';
  preview.classList.add('hidden');
}

function showMediaPreview(file) {
  const preview = $('#mediaPreview');
  const isImage = file.type.startsWith('image/');
  if (state.pendingMediaUrl) URL.revokeObjectURL(state.pendingMediaUrl);
  state.pendingMediaUrl = isImage ? URL.createObjectURL(file) : null;
  const thumb = isImage
    ? `<img src="${state.pendingMediaUrl}" alt="">`
    : '<span class="media-preview-icon">📄</span>';
  preview.innerHTML = `
    <div class="media-preview-card">
      ${thumb}
      <div class="media-preview-info">
        <strong>${escapeHtml(file.name)}</strong>
        <small>${escapeHtml(formatFileSize(file.size))}</small>
      </div>
      <button type="button" class="media-preview-remove" title="Kaldır">✕</button>
    </div>`;
  preview.classList.remove('hidden');
  preview.querySelector('.media-preview-remove').addEventListener('click', clearMediaSelection);
}

export {
  handleFormSubmit,
  refreshAll,
  bootstrap,
  isStaff,
  isAuditor,
  isManager,
  isAdmin,
  isDepartmentSupervisor,
  canManageCloudApiSettings,
  canManageAccounts,
  applyRoleNavigation,
  applyUserFormState,
  restoreLastView,
  restoreLastConversation,
  refreshIncremental,
  scheduleRefresh,
  playNotify,
  connectEvents,
  fillSelects,
  bindUserSearch,
  generateSecurePassword,
  openUserPasswordModal,
  closeUserPasswordModal,
  setUserActive,
  removeManagedUser,
  loadStaffOperations,
  renderReports,
  renderDepartments,
  renderUsers,
  renderPersonnel,
  openPersonnelPanel,
  closePersonnelPanel,
  openPersonnelConversation,
  loadCloudApiSettings,
  applyAccountFormState,
  loadStaffAudit,
  renderTemplates,
  openTemplateModal,
  closeTemplateModal,
  editTemplate,
  removeTemplate,
  renderAccounts,
  openAccountModal,
  closeAccountModal,
  editAccount,
  openDepartmentModal,
  closeDepartmentModal,
  removeDepartment,
  exportManagedUser,
  restoreFromBackup,
  deleteAccount,
  selectConversation,
  loadMessages,
  hideChatMessage,
  loadAuditLogs,
  confirmAction,
  switchView,
  serializeForm,
  disconnectAccount,
  checkAccountHealth,
  renderTemplateVariables,
  collectTemplateVariables,
  sendMediaFile,
  clearMediaSelection,
  showMediaPreview,
  refreshComposerState,
  selectChatAccount,
  openStaffAccount,
  isTemplateOnlyMode,
  renderConversations,
  renderChatAccountStrip
};
