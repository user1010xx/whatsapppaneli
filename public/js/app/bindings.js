import {
  state,
  $,
  $$,
  api,
  flash,
  flashError,
  escapeHtml
} from './core.js';
import {
  handleFormSubmit,
  serializeForm,
  isStaff,
  isManager,
  isAdmin,
  isDepartmentSupervisor,
  isTemplateOnlyMode,
  bootstrap,
  refreshAll,
  switchView,
  disconnectAccount,
  checkAccountHealth,
  editAccount,
  deleteAccount,
  editTemplate,
  removeTemplate,
  openUserPasswordModal,
  closeUserPasswordModal,
  setUserActive,
  removeManagedUser,
  exportManagedUser,
  openDepartmentModal,
  removeDepartment,
  selectConversation,
  openStaffAccount,
  openPersonnelPanel,
  closePersonnelPanel,
  openPersonnelConversation,
  hideChatMessage,
  restoreFromBackup,
  closeTemplateModal,
  closeAccountModal,
  closeDepartmentModal,
  renderTemplateVariables,
  collectTemplateVariables,
  sendMediaFile,
  clearMediaSelection,
  showMediaPreview,
  refreshComposerState,
  generateSecurePassword,
  renderConversations,
  renderChatAccountStrip
} from './views.js';

export function registerBindings() {
  window.disconnectAccount = disconnectAccount;
  window.checkAccountHealth = checkAccountHealth;
  window.editAccount = editAccount;
  window.deleteAccount = deleteAccount;
  window.editTemplate = editTemplate;
  window.removeTemplate = removeTemplate;
  window.openUserPasswordModal = openUserPasswordModal;
  window.closeUserPasswordModal = closeUserPasswordModal;
  window.setUserActive = setUserActive;
  window.removeManagedUser = removeManagedUser;
  window.exportManagedUser = exportManagedUser;
  window.openDepartmentModal = openDepartmentModal;
  window.removeDepartment = removeDepartment;

  $('#departmentList')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-department-action]');
    if (!button) return;
    const departmentId = button.dataset.departmentId;
    const action = button.dataset.departmentAction;
    if (!departmentId || action !== 'delete') return;
    await removeDepartment(departmentId);
  });
  window.selectConversation = selectConversation;
  window.openStaffAccount = openStaffAccount;
  window.openPersonnelPanel = openPersonnelPanel;
  window.closePersonnelPanel = closePersonnelPanel;
  window.openPersonnelConversation = openPersonnelConversation;
  window.hideChatMessage = hideChatMessage;

  $('#userList')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-user-action]');
    if (!button) return;
    const userId = button.dataset.userId;
    const action = button.dataset.userAction;
    if (!userId || !action) return;
    if (action === 'password') openUserPasswordModal(userId);
    else if (action === 'deactivate') await setUserActive(userId, false);
    else if (action === 'activate') await setUserActive(userId, true);
    else if (action === 'delete') await removeManagedUser(userId);
    else if (action === 'export') await exportManagedUser(userId);
  });

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
  // Farklı kullanıcı giriş yaparsa önceki oturumun görünümü/sohbeti taşınmasın.
  try {
    localStorage.removeItem('wp.activeView');
    localStorage.removeItem('wp.activeConversationId');
  } catch { /* storage kapalı */ }
  location.reload();
});

$$('nav button[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-jump]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.jump)));
$('#departmentForm').addEventListener('submit', (event) => handleFormSubmit(
  event,
  (form) => api('/api/departments', { method: 'POST', body: serializeForm(form) }),
  'Departman eklendi'
));

$('#userForm').addEventListener('submit', (event) => handleFormSubmit(
  event,
  (form) => {
    const payload = serializeForm(form);
    if (isManager() && state.me?.departmentId) {
      payload.departmentId = state.me.departmentId;
    }
    return api('/api/users', { method: 'POST', body: payload });
  },
  'Kullanıcı eklendi'
));

$('#generatePassword').addEventListener('click', () => {
  $('#userPassword').value = generateSecurePassword();
  flash('Güvenli şifre üretildi');
});

$('#generatePasswordModal')?.addEventListener('click', () => {
  $('#userPasswordModalInput').value = generateSecurePassword();
  flash('Güvenli şifre üretildi');
});

$$('[data-close-user-password]').forEach((button) => {
  button.addEventListener('click', closeUserPasswordModal);
});

$('#userPasswordForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const userId = $('#userPasswordUserId').value;
  const password = $('#userPasswordModalInput').value?.trim();
  try {
    window.WPHelpers?.validatePassword(password);
  } catch (error) {
    flashError(error);
    return;
  }
  try {
    await api(`/api/users/${userId}`, { method: 'PATCH', body: { password } });
    closeUserPasswordModal();
    await refreshAll();
    flash('Şifre güncellendi');
  } catch (error) {
    flashError(error);
  }
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

$$('[data-close-template-edit]').forEach((button) => button.addEventListener('click', closeTemplateModal));
$('#templateEditForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#templateEditId').value;
  try {
    await api(`/api/templates/${id}`, {
      method: 'PATCH',
      body: {
        title: $('#templateEditTitle').value.trim(),
        body: $('#templateEditBody').value.trim(),
        metaTemplateName: $('#templateEditMeta').value.trim(),
        language: $('#templateEditLang').value.trim() || 'tr'
      }
    });
    closeTemplateModal();
    await refreshAll();
    flash('Şablon güncellendi');
  } catch (error) {
    flashError(error);
  }
});

$$('[data-close-account-edit]').forEach((button) => button.addEventListener('click', closeAccountModal));
$('#accountEditForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#accountEditId').value;
  try {
    await api(`/api/accounts/${id}`, {
      method: 'PATCH',
      body: {
        label: $('#accountEditLabel').value.trim(),
        phoneNumber: $('#accountEditPhone').value.trim(),
        cloudPhoneNumberId: $('#accountEditCloudId').value.trim() || null
      }
    });
    closeAccountModal();
    await refreshAll();
    flash('Hesap güncellendi');
  } catch (error) {
    flashError(error);
  }
});

$$('[data-close-department-edit]').forEach((button) => button.addEventListener('click', closeDepartmentModal));
$('#departmentEditForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#departmentEditId').value;
  try {
    await api(`/api/departments/${id}`, {
      method: 'PATCH',
      body: {
        name: $('#departmentEditName').value.trim(),
        active: $('#departmentEditActive').checked
      }
    });
    closeDepartmentModal();
    await refreshAll();
    flash('Departman güncellendi');
  } catch (error) {
    flashError(error);
  }
});

$('#restoreBackupBtn')?.addEventListener('click', restoreFromBackup);

$('#templateForm').addEventListener('submit', (event) => handleFormSubmit(
  event,
  (form) => api('/api/templates', { method: 'POST', body: serializeForm(form) }),
  'Şablon eklendi'
));

$('#accountForm').addEventListener('submit', (event) => handleFormSubmit(
  event,
  async (form) => {
    const payload = serializeForm(form);
    if (isStaff()) {
      return api('/api/accounts', { method: 'POST', body: { phoneNumber: payload.phoneNumber } });
    }
    return api('/api/accounts', { method: 'POST', body: payload });
  },
  isStaff() ? 'Numara eklendi — Canlı Sohbet\'te Hesap olarak görünür' : 'WhatsApp hesabı eklendi'
));

const cloudApiForm = $('#cloudApiForm');
if (cloudApiForm) {
  cloudApiForm.addEventListener('submit', (event) => handleFormSubmit(
    event,
    (form) => api('/api/settings/cloud-api', { method: 'PATCH', body: serializeForm(form) }),
    'Cloud API ayarları kaydedildi'
  ));
}

$('#templateSelect').addEventListener('change', () => {
  const template = state.templates.find((item) => item.id === $('#templateSelect').value);
  if (template) $('#messageText').value = template.body;
  renderTemplateVariables(template?.id);
  refreshComposerState();
});

$('#customerPhone').addEventListener('input', () => refreshComposerState());

$('#chatAccountFilter').addEventListener('change', () => {
  state.selectedChatAccountId = $('#chatAccountFilter').value;
  renderConversations();
  renderChatAccountStrip();
});

$('#attachBtn').addEventListener('click', () => {
  if (!state.currentConversation) {
    flashError(new Error('Önce bir sohbet seçin'));
    return;
  }
  $('#mediaInput').click();
});

$('#mediaInput').addEventListener('change', () => {
  const file = $('#mediaInput').files[0];
  if (!file) return;
  state.pendingMedia = file;
  showMediaPreview(file);
});

$('#sendForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.sendingMessage) return;
  const sendBtn = $('#sendBtn');
  state.sendingMessage = true;
  if (sendBtn) sendBtn.disabled = true;
  try {
    const file = state.pendingMedia;
    const caption = $('#messageText').value;
    // Medya gönderimi: dosya seçiliyse ham yükleme yap.
    if (file) {
      const result = await sendMediaFile(file, caption);
      clearMediaSelection();
      $('#messageText').value = '';
      $('#templateSelect').value = '';
      await refreshAll();
      await selectConversation(result.conversation.id);
      flash('Dosya gönderildi');
      return;
    }
    const typedPhone = $('#customerPhone').value.trim();
    if (!typedPhone) {
      flashError(new Error('Alıcı telefon numarası gerekli'));
      return;
    }
    const templateId = $('#templateSelect').value || null;
    const templateOnly = isTemplateOnlyMode();
    if (templateOnly) {
      const template = state.templates.find((item) => item.id === templateId);
      if (!template?.metaTemplateName) {
        flashError(new Error('Bu aşamada yalnızca Meta onaylı şablon gönderebilirsiniz'));
        return;
      }
    } else if (!caption.trim()) {
      flashError(new Error('Mesaj boş olamaz'));
      return;
    }
    const sameConversationPhone = state.currentConversation && typedPhone === state.currentConversation.customerPhone;
    const body = {
      accountId: state.currentConversation?.accountId || state.selectedChatAccountId || $('#chatAccountFilter').value,
      conversationId: sameConversationPhone ? state.currentConversation.id : null,
      customerPhone: typedPhone,
      text: caption || state.templates.find((item) => item.id === templateId)?.body || '',
      templateId,
      variables: collectTemplateVariables(),
      idempotencyKey: crypto.randomUUID()
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
  } finally {
    state.sendingMessage = false;
    refreshComposerState();
  }
});

$('#mobileNavToggle')?.addEventListener('click', () => {
  document.body.classList.toggle('mobile-nav-open');
});

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission().catch(() => {});
}


}
