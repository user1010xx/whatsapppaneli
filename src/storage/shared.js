const emptyData = () => ({
  users: [],
  departments: [],
  templates: [],
  whatsappAccounts: [],
  conversations: [],
  messages: [],
  auditLogs: [],
  webhookDedup: [],
  panelSettings: {
    cloudApi: {
      baseUrl: '',
      accessToken: '',
      phoneNumberId: '',
      wabaId: '',
      webhookVerifyToken: '',
      appSecret: '',
      updatedAt: null,
      updatedBy: null
    }
  }
});

module.exports = { emptyData };