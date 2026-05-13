// Auth guard and user UI initialization
(async function initAuth() {
  const token = localStorage.getItem('webgis_token');
  if (!token) {
    window.location.href = '/login.html';
    return;
  }

  try {
    const res = await apiFetch('/api/auth/me');
    if (!res.ok) throw new Error('Auth failed');
    const user = await res.json();
    localStorage.setItem('webgis_user', JSON.stringify(user));
    setupUserUI(user);
  } catch {
    window.location.href = '/login.html';
  }
})();

function setupUserUI(user) {
  const initials = user.username.slice(0, 2).toUpperCase();
  document.getElementById('userAvatar').textContent = initials;
  document.getElementById('userAvatarLg').textContent = initials;
  document.getElementById('userNameDisplay').textContent = user.username;
  document.getElementById('dropdownUsername').textContent = user.username;
  document.getElementById('dropdownEmail').textContent = user.email;

  if (user.is_admin) {
    document.getElementById('adminPanelBtn').style.display = 'flex';
  }
}

// Toggle user dropdown
document.getElementById('userMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('userDropdown').classList.toggle('open');
});

document.addEventListener('click', () => {
  document.getElementById('userDropdown').classList.remove('open');
});

// Logout
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  localStorage.removeItem('webgis_token');
  localStorage.removeItem('webgis_user');
  window.location.href = '/login.html';
});

// Admin panel
document.getElementById('adminPanelBtn').addEventListener('click', () => {
  document.getElementById('userDropdown').classList.remove('open');
  openAdminPanel();
});

// ===== Admin Panel =====
async function openAdminPanel() {
  document.getElementById('adminModal').style.display = 'flex';
  document.getElementById('addUserForm').style.display = 'none';
  await loadUsers();
}

document.getElementById('adminModalClose').addEventListener('click', () => {
  document.getElementById('adminModal').style.display = 'none';
});

document.getElementById('adminModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('adminModal')) {
    document.getElementById('adminModal').style.display = 'none';
  }
});

async function loadUsers() {
  try {
    const res = await apiFetch('/api/users/');
    if (!res.ok) throw new Error();
    const users = await res.json();
    renderUserTable(users);
  } catch {
    setStatus('adminStatus', 'Failed to load users', 'error');
  }
}

function renderUserTable(users) {
  const tbody = document.getElementById('userTableBody');
  const currentUser = JSON.parse(localStorage.getItem('webgis_user') || '{}');

  tbody.innerHTML = users.map(u => `
    <tr>
      <td><strong>${u.username}</strong>${u.id === currentUser.id ? ' <span style="color:var(--accent);font-size:10px">(you)</span>' : ''}</td>
      <td>${u.email}</td>
      <td><span class="badge ${u.is_admin ? 'badge-admin' : 'badge-user'}">${u.is_admin ? 'Admin' : 'User'}</span></td>
      <td><span class="badge ${u.is_active ? 'badge-active' : 'badge-inactive'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td>
        <div style="display:flex;gap:4px">
          ${u.id !== currentUser.id ? `
            <button class="layer-action-btn" onclick="toggleUserActive(${u.id}, ${!u.is_active})" title="${u.is_active ? 'Deactivate' : 'Activate'}">
              <i class="fas fa-${u.is_active ? 'ban' : 'check'}"></i>
            </button>
            <button class="layer-action-btn" onclick="toggleUserAdmin(${u.id}, ${!u.is_admin})" title="${u.is_admin ? 'Remove admin' : 'Make admin'}">
              <i class="fas fa-${u.is_admin ? 'user' : 'crown'}"></i>
            </button>
            <button class="layer-action-btn danger" onclick="deleteUser(${u.id}, '${u.username}')" title="Delete user">
              <i class="fas fa-trash"></i>
            </button>
          ` : '<span style="color:var(--text-muted);font-size:11px">—</span>'}
        </div>
      </td>
    </tr>
  `).join('');
}

window.toggleUserActive = async (userId, active) => {
  const res = await apiFetch(`/api/users/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_active: active }),
  });
  if (res.ok) { loadUsers(); showToast(`User ${active ? 'activated' : 'deactivated'}`, 'success'); }
};

window.toggleUserAdmin = async (userId, admin) => {
  const res = await apiFetch(`/api/users/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_admin: admin }),
  });
  if (res.ok) { loadUsers(); showToast(`Admin ${admin ? 'granted' : 'revoked'}`, 'success'); }
};

window.deleteUser = async (userId, username) => {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  const res = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
  if (res.ok) { loadUsers(); showToast('User deleted', 'success'); }
};

// Add user form
document.getElementById('addUserBtn').addEventListener('click', () => {
  document.getElementById('addUserForm').style.display = 'block';
});
document.getElementById('cancelAddUser').addEventListener('click', () => {
  document.getElementById('addUserForm').style.display = 'none';
});
document.getElementById('saveNewUser').addEventListener('click', async () => {
  const username = document.getElementById('newUsername').value.trim();
  const email = document.getElementById('newEmail').value.trim();
  const password = document.getElementById('newPassword').value;
  const is_admin = document.getElementById('newIsAdmin').checked;

  if (!username || !email || !password) {
    setStatus('adminStatus', 'All fields are required', 'error');
    return;
  }

  const res = await apiFetch('/api/users/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password, is_admin }),
  });

  if (res.ok) {
    document.getElementById('addUserForm').style.display = 'none';
    document.getElementById('newUsername').value = '';
    document.getElementById('newEmail').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('newIsAdmin').checked = false;
    loadUsers();
    showToast(`User "${username}" created`, 'success');
    setStatus('adminStatus', '', '');
  } else {
    const err = await res.json();
    setStatus('adminStatus', err.detail || 'Failed to create user', 'error');
  }
});
