const roles = {
  admin: 'admin',
  manager: 'manager',
  auditor: 'auditor',
  staff: 'staff'
};

function isAdmin(user) {
  return user?.role === roles.admin;
}

function isManager(user) {
  return user?.role === roles.manager;
}

function sameDepartment(user, departmentId) {
  return Boolean(user?.departmentId && departmentId && user.departmentId === departmentId);
}

function canManageDepartments(user) {
  return isAdmin(user);
}

function canManageUsers(actor, targetDepartmentId) {
  if (isAdmin(actor)) return true;
  return isManager(actor) && sameDepartment(actor, targetDepartmentId);
}

function canManageTemplates(actor) {
  return isAdmin(actor);
}

function canManageCloudApiSettings(actor) {
  return isAdmin(actor) || isManager(actor);
}

function canReadDepartment(actor, departmentId) {
  if (isAdmin(actor)) return true;
  if (isManager(actor) || actor?.role === roles.auditor) return sameDepartment(actor, departmentId);
  return false;
}

function canOperateDepartment(actor, departmentId) {
  if (isAdmin(actor)) return true;
  if (isManager(actor)) return sameDepartment(actor, departmentId);
  return false;
}

function canReadUser(actor, targetUser) {
  if (!targetUser) return false;
  if (isAdmin(actor)) return true;
  if (actor?.id === targetUser.id) return true;
  return canReadDepartment(actor, targetUser.departmentId);
}

function canAuditorSuperviseStaff(actor, targetUser) {
  return actor?.role === roles.auditor
    && targetUser?.role === roles.staff
    && sameDepartment(actor, targetUser.departmentId);
}

function canManagerSuperviseStaff(actor, targetUser) {
  return isManager(actor)
    && targetUser?.role === roles.staff
    && sameDepartment(actor, targetUser.departmentId);
}

function canCreateUserRole(actor, role) {
  if (isAdmin(actor)) return true;
  if (isManager(actor)) return role === roles.staff || role === roles.auditor;
  return false;
}

function managerMayEditTarget(actor, targetUser) {
  if (!isManager(actor)) return true;
  if (!targetUser) return false;
  return targetUser.role === roles.staff || targetUser.role === roles.auditor;
}

function canManagerEditUser(actor, targetUser) {
  return managerMayEditTarget(actor, targetUser);
}

function canOperateUser(actor, targetUser) {
  if (!targetUser) return false;
  if (actor?.id === targetUser.id && actor?.role === roles.staff) return true;
  if (canAuditorSuperviseStaff(actor, targetUser)) return true;
  if (canManagerSuperviseStaff(actor, targetUser)) return true;
  return canOperateDepartment(actor, targetUser.departmentId);
}

function canCreateStaffAccount(actor, targetUser) {
  if (!targetUser) return false;
  if (actor?.role === roles.auditor) return false;
  if (actor?.id === targetUser.id && actor?.role === roles.staff) return true;
  return canOperateDepartment(actor, targetUser.departmentId) && targetUser.role === roles.staff;
}

function canDeleteAccount(actor, targetUser) {
  if (actor?.role === roles.staff) return false;
  return canOperateDepartment(actor, targetUser?.departmentId);
}

function canDisconnectAccount(actor, targetUser) {
  if (actor?.role === roles.staff) return false;
  return canOperateDepartment(actor, targetUser?.departmentId);
}

function canHideMessage(actor, departmentId) {
  if (!actor) return false;
  if (actor.role === roles.staff || actor.role === roles.auditor) return false;
  if (isAdmin(actor)) return true;
  if (isManager(actor)) return sameDepartment(actor, departmentId);
  return false;
}

function canViewStaffAudit(actor) {
  return isAdmin(actor) || isManager(actor);
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, totpSecret, totpPendingSecret, ...safeUser } = user;
  return {
    ...safeUser,
    totpEnabled: Boolean(user.totpEnabled),
    hasTotpPending: Boolean(user.totpPendingSecret)
  };
}

module.exports = {
  canManageCloudApiSettings,
  canManageDepartments,
  canManageTemplates,
  canManageUsers,
  canAuditorSuperviseStaff,
  canManagerSuperviseStaff,
  canCreateUserRole,
  canManagerEditUser,
  managerMayEditTarget,
  canCreateStaffAccount,
  canOperateDepartment,
  canOperateUser,
  canDeleteAccount,
  canDisconnectAccount,
  canHideMessage,
  canReadDepartment,
  canReadUser,
  canViewStaffAudit,
  isAdmin,
  isManager,
  publicUser,
  roles,
  sameDepartment
};