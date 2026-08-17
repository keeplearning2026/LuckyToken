#![cfg(windows)]

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{Buffer, Result};
use napi_derive::napi;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_IO_PENDING,
    ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    GetAce, GetSecurityDescriptorControl, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL,
    DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeInfo, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

const PIPE_ACCESS_MASK: u32 = 0x0012_019f;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
type RawHandle = usize;

fn error(context: &str) -> napi::Error {
    napi::Error::from_reason(format!("{context}: Windows error {}", unsafe {
        GetLastError()
    }))
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn query_current_user_sid() -> Result<String> {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(error("OpenProcessToken"));
        }
        let mut bytes = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut bytes);
        let mut buffer = vec![0_u8; bytes as usize];
        if GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            bytes,
            &mut bytes,
        ) == 0
        {
            CloseHandle(token);
            return Err(error("GetTokenInformation(TokenUser)"));
        }
        let token_user = buffer.as_ptr() as *const TOKEN_USER;
        let mut sid_text = null_mut();
        if ConvertSidToStringSidW((*token_user).User.Sid, &mut sid_text) == 0 {
            CloseHandle(token);
            return Err(error("ConvertSidToStringSidW"));
        }
        let mut length = 0;
        while *sid_text.add(length) != 0 {
            length += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, length));
        LocalFree(sid_text as *mut c_void);
        CloseHandle(token);
        Ok(sid)
    }
}

#[napi(js_name = "currentUserSid")]
pub fn current_user_sid() -> Result<String> {
    query_current_user_sid()
}

struct SecurityDescriptor(*mut c_void);

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn create_security_descriptor(sid: &str) -> Result<SecurityDescriptor> {
    // The protected DACL has exactly one ACE: this process's TokenUser SID. The mask is
    // FILE_READ/WRITE_DATA, FILE_CREATE_PIPE_INSTANCE, required file metadata rights, and SYNCHRONIZE.
    let sddl = wide(&format!("D:P(A;;0x{PIPE_ACCESS_MASK:08x};;;{sid})"));
    let mut descriptor = null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        ) == 0
        {
            return Err(error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            ));
        }
    }
    Ok(SecurityDescriptor(descriptor))
}

fn create_pipe(name: &str, sid: &str) -> Result<RawHandle> {
    let descriptor = create_security_descriptor(sid)?;
    let attributes = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        nLength: size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let name = wide(name);
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(error("CreateNamedPipeW"));
    }
    Ok(handle as RawHandle)
}

fn wait_overlapped(
    handle: RawHandle,
    start: i32,
    overlapped: &mut OVERLAPPED,
    context: &str,
) -> Result<u32> {
    unsafe {
        if start == 0 {
            let code = GetLastError();
            if code != ERROR_IO_PENDING {
                return Err(napi::Error::from_reason(format!(
                    "{context}: Windows error {code}"
                )));
            }
        }
        WaitForSingleObject(overlapped.hEvent, INFINITE);
        let mut transferred = 0;
        if GetOverlappedResult(handle as HANDLE, overlapped, &mut transferred, 0) == 0 {
            return Err(error(context));
        }
        Ok(transferred)
    }
}

fn new_overlapped() -> Result<OVERLAPPED> {
    unsafe {
        let event = CreateEventW(null(), 1, 0, null());
        if event.is_null() {
            return Err(error("CreateEventW"));
        }
        let mut overlapped: OVERLAPPED = zeroed();
        overlapped.hEvent = event;
        Ok(overlapped)
    }
}

fn close_overlapped(overlapped: &OVERLAPPED) {
    unsafe { CloseHandle(overlapped.hEvent) };
}

struct ServerState {
    pending: Option<RawHandle>,
    active_accept: Option<RawHandle>,
    closed: bool,
}

struct ServerInner {
    name: String,
    sid: String,
    state: Mutex<ServerState>,
}

impl ServerInner {
    fn accept(&self) -> Result<NativePipeConnection> {
        let handle = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(napi::Error::from_reason("named-pipe server is closed"));
            }
            let handle = state
                .pending
                .take()
                .ok_or_else(|| napi::Error::from_reason("accept already pending"))?;
            state.active_accept = Some(handle);
            handle
        };
        let mut overlapped = match new_overlapped() {
            Ok(overlapped) => overlapped,
            Err(reason) => {
                self.restore_unstarted_accept(handle);
                return Err(reason);
            }
        };
        let connect = unsafe { ConnectNamedPipe(handle as HANDLE, &mut overlapped) };
        let connected = if connect == 0 && unsafe { GetLastError() } == ERROR_PIPE_CONNECTED {
            Ok(0)
        } else {
            wait_overlapped(handle, connect, &mut overlapped, "ConnectNamedPipe")
        };
        close_overlapped(&overlapped);
        let mut state = self.state.lock().unwrap();
        state.active_accept = None;
        if state.closed {
            unsafe { CloseHandle(handle as HANDLE) };
            return Err(napi::Error::from_reason(
                "named-pipe server was closed during accept",
            ));
        }
        if let Err(reason) = connected {
            unsafe { CloseHandle(handle as HANDLE) };
            state.pending = Some(create_pipe(&self.name, &self.sid)?);
            return Err(reason);
        }
        let next = match create_pipe(&self.name, &self.sid) {
            Ok(next) => next,
            Err(reason) => {
                unsafe { CloseHandle(handle as HANDLE) };
                return Err(reason);
            }
        };
        state.pending = Some(next);
        Ok(NativePipeConnection {
            inner: Arc::new(ConnectionInner::new(handle)),
        })
    }

    fn restore_unstarted_accept(&self, handle: RawHandle) {
        let mut state = self.state.lock().unwrap();
        state.active_accept = None;
        if state.closed {
            unsafe { CloseHandle(handle as HANDLE) };
        } else {
            state.pending = Some(handle);
        }
    }

    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        if let Some(handle) = state.pending.take() {
            unsafe { CloseHandle(handle as HANDLE) };
        }
        if let Some(handle) = state.active_accept {
            unsafe { CancelIoEx(handle as HANDLE, null()) };
        }
    }

    fn security_policy(&self) -> Result<SecurityPolicy> {
        let state = self.state.lock().unwrap();
        let handle = state
            .pending
            .or(state.active_accept)
            .ok_or_else(|| napi::Error::from_reason("no inspectable pipe instance"))?;
        let mut flags = 0;
        unsafe {
            if GetNamedPipeInfo(
                handle as HANDLE,
                &mut flags,
                null_mut(),
                null_mut(),
                null_mut(),
            ) == 0
            {
                return Err(error("GetNamedPipeInfo"));
            }
        }
        let (dacl_protected, verified_sid, access_mask) = unsafe {
            let mut descriptor = null_mut();
            let mut dacl: *mut ACL = null_mut();
            let status = GetSecurityInfo(
                handle as HANDLE,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            );
            if status != 0 {
                return Err(napi::Error::from_reason(format!(
                    "GetSecurityInfo: Windows error {status}"
                )));
            }
            let mut control = 0;
            let mut revision = 0;
            let protected = GetSecurityDescriptorControl(descriptor, &mut control, &mut revision)
                != 0
                && control & SE_DACL_PROTECTED != 0;
            if dacl.is_null() || (*dacl).AceCount != 1 {
                LocalFree(descriptor);
                return Err(napi::Error::from_reason("pipe DACL is not exactly one ACE"));
            }
            let mut ace = null_mut();
            if GetAce(dacl, 0, &mut ace) == 0 {
                LocalFree(descriptor);
                return Err(error("GetAce"));
            }
            let allowed = ace as *const ACCESS_ALLOWED_ACE;
            if (*allowed).Header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                LocalFree(descriptor);
                return Err(napi::Error::from_reason(
                    "pipe DACL ACE is not an allow ACE",
                ));
            }
            let mask = (*allowed).Mask;
            let sid_pointer = &(*allowed).SidStart as *const u32 as *mut c_void;
            let mut sid_text = null_mut();
            if ConvertSidToStringSidW(sid_pointer, &mut sid_text) == 0 {
                LocalFree(descriptor);
                return Err(error("ConvertSidToStringSidW(pipe DACL)"));
            }
            let mut length = 0;
            while *sid_text.add(length) != 0 {
                length += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, length));
            LocalFree(sid_text as *mut c_void);
            LocalFree(descriptor);
            (protected, sid, mask)
        };
        if verified_sid != self.sid || access_mask != PIPE_ACCESS_MASK {
            return Err(napi::Error::from_reason(
                "pipe DACL does not grant only the expected TokenUser rights",
            ));
        }
        Ok(SecurityPolicy {
            owner_sid: verified_sid,
            dacl_protected,
            access_mask,
            reject_remote_clients: flags & PIPE_REJECT_REMOTE_CLIENTS != 0,
        })
    }
}

impl Drop for ServerInner {
    fn drop(&mut self) {
        self.close();
    }
}

struct ConnectionState {
    handle: Option<RawHandle>,
    active_operations: usize,
    closed: bool,
}

struct ConnectionInner {
    state: Mutex<ConnectionState>,
}

impl ConnectionInner {
    fn new(handle: RawHandle) -> Self {
        Self {
            state: Mutex::new(ConnectionState {
                handle: Some(handle),
                active_operations: 0,
                closed: false,
            }),
        }
    }

    fn begin(&self) -> Result<RawHandle> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(napi::Error::from_reason("named-pipe connection is closed"));
        }
        state.active_operations += 1;
        state
            .handle
            .ok_or_else(|| napi::Error::from_reason("named-pipe connection has no handle"))
    }

    fn finish(&self) {
        let mut state = self.state.lock().unwrap();
        state.active_operations -= 1;
        if state.closed && state.active_operations == 0 {
            if let Some(handle) = state.handle.take() {
                unsafe {
                    DisconnectNamedPipe(handle as HANDLE);
                    CloseHandle(handle as HANDLE);
                }
            }
        }
    }

    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        state.closed = true;
        if let Some(handle) = state.handle {
            unsafe { CancelIoEx(handle as HANDLE, null()) };
            if state.active_operations == 0 {
                unsafe {
                    DisconnectNamedPipe(handle as HANDLE);
                    CloseHandle(handle as HANDLE);
                }
                state.handle = None;
            }
        }
    }

    fn read(&self, max_bytes: u32) -> Result<Option<Buffer>> {
        if max_bytes == 0 {
            return Err(napi::Error::from_reason(
                "maxBytes must be greater than zero",
            ));
        }
        let handle = self.begin()?;
        let mut bytes = vec![0_u8; max_bytes as usize];
        let mut overlapped = match new_overlapped() {
            Ok(overlapped) => overlapped,
            Err(reason) => {
                self.finish();
                return Err(reason);
            }
        };
        let start = unsafe {
            ReadFile(
                handle as HANDLE,
                bytes.as_mut_ptr(),
                max_bytes,
                null_mut(),
                &mut overlapped,
            )
        };
        let result = match wait_overlapped(handle, start, &mut overlapped, "ReadFile") {
            Ok(0) => Ok(None),
            Ok(read) => {
                bytes.truncate(read as usize);
                Ok(Some(Buffer::from(bytes)))
            }
            Err(_) if unsafe { GetLastError() } == ERROR_BROKEN_PIPE => Ok(None),
            Err(reason) => Err(reason),
        };
        close_overlapped(&overlapped);
        self.finish();
        result
    }

    fn write(&self, bytes: Vec<u8>) -> Result<()> {
        let handle = self.begin()?;
        let mut offset = 0;
        let result = (|| {
            while offset < bytes.len() {
                let mut overlapped = new_overlapped()?;
                let start = unsafe {
                    WriteFile(
                        handle as HANDLE,
                        bytes[offset..].as_ptr(),
                        (bytes.len() - offset) as u32,
                        null_mut(),
                        &mut overlapped,
                    )
                };
                let written = wait_overlapped(handle, start, &mut overlapped, "WriteFile");
                close_overlapped(&overlapped);
                offset += written? as usize;
            }
            Ok(())
        })();
        self.finish();
        result
    }
}

impl Drop for ConnectionInner {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi(object)]
pub struct SecurityPolicy {
    pub owner_sid: String,
    pub dacl_protected: bool,
    pub access_mask: u32,
    pub reject_remote_clients: bool,
}

#[napi]
pub struct NativePipeServer {
    inner: Arc<ServerInner>,
}

#[napi]
impl NativePipeServer {
    #[napi(constructor)]
    pub fn new(name: String) -> Result<Self> {
        if !name.starts_with(r"\\.\pipe\") {
            return Err(napi::Error::from_reason(
                "pipe name must start with \\.\\pipe\\",
            ));
        }
        let sid = query_current_user_sid()?;
        let pending = create_pipe(&name, &sid)?;
        Ok(Self {
            inner: Arc::new(ServerInner {
                name,
                sid,
                state: Mutex::new(ServerState {
                    pending: Some(pending),
                    active_accept: None,
                    closed: false,
                }),
            }),
        })
    }

    #[napi]
    pub async fn accept(&self) -> Result<NativePipeConnection> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || inner.accept())
            .await
            .map_err(|_| napi::Error::from_reason("accept worker stopped"))?
    }

    #[napi]
    pub fn security_policy(&self) -> Result<SecurityPolicy> {
        self.inner.security_policy()
    }

    #[napi]
    pub fn close(&self) {
        self.inner.close();
    }
}

#[napi]
pub struct NativePipeConnection {
    inner: Arc<ConnectionInner>,
}

#[napi]
impl NativePipeConnection {
    #[napi]
    pub async fn read(&self, max_bytes: u32) -> Result<Option<Buffer>> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || inner.read(max_bytes))
            .await
            .map_err(|_| napi::Error::from_reason("read worker stopped"))?
    }

    #[napi]
    pub async fn write(&self, bytes: Buffer) -> Result<()> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || inner.write(bytes.to_vec()))
            .await
            .map_err(|_| napi::Error::from_reason("write worker stopped"))?
    }

    #[napi]
    pub fn close(&self) {
        self.inner.close();
    }
}
