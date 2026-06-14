const roles = {
  admin: 'admin',
  manager: 'manager',
  auditor: 'auditor',
  staff: 'staff'
};

function isAdmin(user) {
  return user?.role === roles.admin;
}

function sameDepartment(user, departmentId) {
  return Boolean(user?.departmentId && departmentId && user.departmentId === departmentId);
}

function canManageDepartments(user) {
  return isAdmin(user);
}

function canManageUsers(actor, targetDepartmentId) {
  if (isAdmin(actor)) return true;
  return actor?.role === roles.manager && sameDepartment(actor, targetDepartmentId);
}

function canManageTemplates(actor, templateDepartmentId) {
  if (isAdmin(actor)) return true;
  return actor?.role === roles.manager && sameDepartment(actor, templateDepartmentId);
}

function canReadDepartment(actor, departmentId) {
  if (isAdmin(actor)) return true;
  if (actor?.role === roles.manager || actor?.role === roles.auditor) return sameDepartment(actor, departmentId);
  return false;
}

function canOperateDepartment(actor, departmentId) {
  if (isAdmin(actor)) return true;
  if (actor?.role === roles.manager) return sameDepartment(actor, departmentId);
  return false;
}

function canReadUser(actor, targetUser) {
  if (!targetUser) return false;
  if (isAdmin(actor)) return true;
  if (actor?.id === targetUser.id) return true;
  return canReadDepartment(actor, targetUser.departmentId);
}

function canOperateUser(actor, targetUser) {
  if (!targetUser) return false;
  if (actor?.id === targetUser.id && actor?.role === roles.staff) return true;
  return canOperateDepartment(actor, targetUser.departmentId);
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

module.exports = {
  canManageDepartments,
  canManageTemplates,
  canManageUsers,
  canOperateDepartment,
  canOperateUser,
  canReadDepartment,
  canReadUser,
  isAdmin,
  publicUser,
  roles,
  sameDepartment
};