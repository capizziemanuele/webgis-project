// ===== File Upload =====
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('uploadFile');
let selectedFile = null;

document.getElementById('uploadBtn').addEventListener('click', openUploadModal);
document.getElementById('uploadModalClose').addEventListener('click', closeUploadModal);
document.getElementById('uploadModalCancel').addEventListener('click', closeUploadModal);
document.getElementById('uploadModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('uploadModal')) closeUploadModal();
});

function openUploadModal() {
  document.getElementById('uploadModal').style.display = 'flex';
  setStatus('uploadStatus', '', '');
  document.getElementById('uploadProgress').style.display = 'none';
  document.getElementById('selectedFileName').style.display = 'none';
  selectedFile = null;
  document.getElementById('uploadName').value = '';
  document.getElementById('uploadDesc').value = '';
}

function closeUploadModal() {
  document.getElementById('uploadModal').style.display = 'none';
}

// Drop zone events
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelected(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
});

function handleFileSelected(file) {
  selectedFile = file;
  const nameEl = document.getElementById('selectedFileName');
  nameEl.innerHTML = `<i class="fas fa-file"></i> ${file.name} (${formatFileSize(file.size)})`;
  nameEl.style.display = 'flex';

  // Auto-fill layer name from filename
  const nameInput = document.getElementById('uploadName');
  if (!nameInput.value) {
    nameInput.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

document.getElementById('uploadSubmitBtn').addEventListener('click', async () => {
  const name = document.getElementById('uploadName').value.trim();
  const desc = document.getElementById('uploadDesc').value.trim();

  if (!name) { setStatus('uploadStatus', 'Layer name is required', 'error'); return; }
  if (!selectedFile) { setStatus('uploadStatus', 'Please select a file', 'error'); return; }

  const btn = document.getElementById('uploadSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';

  const progressEl = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  progressEl.style.display = 'block';

  setStatus('uploadStatus', '', '');

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('name', name);
  formData.append('description', desc);

  // XHR for progress
  const xhr = new XMLHttpRequest();
  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 70);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `Uploading... ${pct}%`;
    }
  });

  xhr.onload = async () => {
    progressFill.style.width = '100%';
    progressText.textContent = 'Processing...';

    if (xhr.status === 200) {
      const layer = JSON.parse(xhr.responseText);
      setStatus('uploadStatus', `Layer "${name}" created with ${layer.feature_count || 0} features.`, 'success');
      await loadLayer(layer);
      setTimeout(() => {
        zoomToLayer(layer.id);
        closeUploadModal();
        showToast(`Layer "${name}" uploaded successfully`, 'success');
      }, 600);
    } else {
      try {
        const err = JSON.parse(xhr.responseText);
        setStatus('uploadStatus', err.detail || 'Upload failed', 'error');
      } catch {
        setStatus('uploadStatus', 'Upload failed', 'error');
      }
      progressEl.style.display = 'none';
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-upload"></i> Upload';
  };

  xhr.onerror = () => {
    setStatus('uploadStatus', 'Network error during upload', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-upload"></i> Upload';
    progressEl.style.display = 'none';
  };

  const token = localStorage.getItem('webgis_token');
  xhr.open('POST', `${API}/api/layers/upload`);
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.send(formData);
});
