/* Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// This trusted broker never accepts an unrestricted fallback. The untrusted process
// starts suspended, with LPAC/zero network capabilities, then enters a kill-on-close Job.
internal static class SandboxRunner
{
    sealed class Request {
        public string root { get; set; }
        public string cwd { get; set; }
        public string runtimeDirectory { get; set; }
        public string executable { get; set; }
        public string[] arguments { get; set; }
        public int timeoutMs { get; set; }
        public int maxOutputBytes { get; set; }
#if WHALELIFE_TEST_FAULTS
        public string testFault { get; set; }
        public string testCleanupProfile { get; set; }
#endif
    }
    sealed class Result {
        public string status = "failed";
        public long? exitCode = null;
        public string stdout = "";
        public string stderr = "";
        public bool truncated = false;
        public long elapsedMs = 0;
        public string reason = null;
        public bool profileDeleted = false;
        public string profileId = null;
    }
    sealed class CaptureBudget { public int left; public CaptureBudget(int value) { left=value; } }
    sealed class Capture {
        readonly Stream stream;
        readonly CaptureBudget budget;
        readonly MemoryStream kept = new MemoryStream();
        public bool truncated;
        public Capture(IntPtr handle, CaptureBudget shared) {
            stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false);
            budget = shared;
        }
        public void Read() {
            byte[] chunk = new byte[4096];
            try {
                int count;
                while ((count = stream.Read(chunk, 0, chunk.Length)) > 0) {
                    int take;
                    lock (budget) { take=Math.Min(count,budget.left); budget.left-=take; }
                    if (take > 0) kept.Write(chunk, 0, take);
                    if (take < count) truncated = true;
                }
            } catch (IOException) { } finally { stream.Dispose(); }
        }
        public string Text() { return Encoding.UTF8.GetString(kept.ToArray()); }
        public void Close() { stream.Dispose(); }
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr sid; public IntPtr capabilities; public int count; public int reserved; }
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb; public string reserved; public string desktop; public string title;
        public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2; public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public int pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct JobBasicLimits { public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcessLimit; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct JobExtendedLimits { public JobBasicLimits basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct JobAccounting { public long userTime,kernelTime,periodUserTime,periodKernelTime; public uint pageFaults,totalProcesses,activeProcesses,terminatedProcesses; }
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernelbase.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr capabilities, out uint capabilityCount);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr required);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int length, out int required);

    static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    static IntPtr Allocate<T>(T value) { IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T))); Marshal.StructureToPtr(value, p, false); return p; }
    static string Full(string path) { return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar); }
    static void Contained(string root, string path) {
        string resolved = Full(path), prefix = Full(root) + Path.DirectorySeparatorChar;
        if (!resolved.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Path outside owned scratch root");
        string cursor = resolved;
        while (!String.IsNullOrEmpty(cursor)) {
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Reparse points are not allowed");
            cursor = Path.GetDirectoryName(cursor);
        }
    }
    static void ValidateTree(string path) {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Reparse points are not allowed");
        if (Directory.Exists(path)) foreach (string item in Directory.GetFileSystemEntries(path)) ValidateTree(item);
    }
    static void Grant(string path, SecurityIdentifier sid, FileSystemRights rights) {
        DirectorySecurity acl = Directory.GetAccessControl(path);
        acl.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(path, acl);
    }
    static void RemoveGrant(string path, SecurityIdentifier sid) {
        if (!Directory.Exists(path)) return;
        DirectorySecurity acl = Directory.GetAccessControl(path);
        acl.PurgeAccessRules(sid);
        Directory.SetAccessControl(path, acl);
    }
    static string Quote(string value) {
        StringBuilder s = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { s.Append('\\', slashes * 2 + 1); s.Append(c); }
            else { s.Append('\\', slashes); s.Append(c); }
            slashes = 0;
        }
        s.Append('\\', slashes * 2); s.Append('"'); return s.ToString();
    }
    static void Attribute(IntPtr list, long attribute, IntPtr value, int size) { Check(UpdateProcThreadAttribute(list, 0, new IntPtr(attribute), value, new IntPtr(size), IntPtr.Zero, IntPtr.Zero), "Set sandbox attribute"); }
    static IntPtr RegistryReadCapability() {
        IntPtr groups,capabilities; uint groupCount,capabilityCount;
        Check(DeriveCapabilitySidsFromName("registryRead",out groups,out groupCount,out capabilities,out capabilityCount),"Derive runtime registry capability");
        try {
            if (capabilityCount!=1) throw new InvalidOperationException("Unexpected registry capability count");
            SecurityIdentifier identity=new SecurityIdentifier(Marshal.ReadIntPtr(capabilities));
            byte[] bytes=new byte[identity.BinaryLength]; identity.GetBinaryForm(bytes,0);
            IntPtr result=Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes,0,result,bytes.Length); return result;
        } finally {
            for (uint i=0;i<groupCount;i++) LocalFree(Marshal.ReadIntPtr(groups,(int)i*IntPtr.Size));
            for (uint i=0;i<capabilityCount;i++) LocalFree(Marshal.ReadIntPtr(capabilities,(int)i*IntPtr.Size));
            LocalFree(groups); LocalFree(capabilities);
        }
    }
    static bool WaitJobEmpty(IntPtr job) {
        IntPtr info=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JobAccounting))); Stopwatch deadline=Stopwatch.StartNew();
        try {
            do {
                if (!QueryInformationJobObject(job,1,info,(uint)Marshal.SizeOf(typeof(JobAccounting)),IntPtr.Zero)) return false;
                if (((JobAccounting)Marshal.PtrToStructure(info,typeof(JobAccounting))).activeProcesses==0) return true;
                Thread.Sleep(25);
            } while (deadline.ElapsedMilliseconds<5000);
            return false;
        } finally { Marshal.FreeHGlobal(info); }
    }
    static void CleanupStep(string stage, Action action, List<string> failures) {
        try { action(); } catch (Exception) { failures.Add(stage); }
    }
    static void JoinReader(Thread reader) {
        if (reader==null || (reader.ThreadState & System.Threading.ThreadState.Unstarted)!=0) return;
        if (!reader.Join(5000)) throw new InvalidOperationException("Output reader did not stop");
    }

    static Result Run(Request r) {
        Result result = new Result(); Stopwatch watch = Stopwatch.StartNew();
        string profile = "WhaleLife.Computer." + Guid.NewGuid().ToString("N");
        string profileDirectory = null; bool owned = false, profileAttempted = false, attributesInitialized = false, launched = false;
        SecurityIdentifier identity = null;
        IntPtr sid=IntPtr.Zero, job=IntPtr.Zero, attributes=IntPtr.Zero, capabilityMemory=IntPtr.Zero, policyMemory=IntPtr.Zero, handlesMemory=IntPtr.Zero, environment=IntPtr.Zero, registrySid=IntPtr.Zero, capabilityList=IntPtr.Zero, jobListMemory=IntPtr.Zero;
        IntPtr outRead=IntPtr.Zero, outWrite=IntPtr.Zero, errRead=IntPtr.Zero, errWrite=IntPtr.Zero, inRead=IntPtr.Zero, inWrite=IntPtr.Zero;
        ProcessInformation process = new ProcessInformation(); Capture output=null, error=null; Thread outThread=null, errThread=null;
        int cancelRequested = 0;
        try {
            if (r == null || r.arguments == null || r.timeoutMs < 1 || r.timeoutMs > 300000 || r.maxOutputBytes < 1 || r.maxOutputBytes > 262144) throw new InvalidOperationException("Invalid request limits");
            Contained(r.root, r.cwd); Contained(r.root, r.runtimeDirectory);
            if (Full(r.cwd).Equals(Full(r.runtimeDirectory), StringComparison.OrdinalIgnoreCase) || Full(r.runtimeDirectory).StartsWith(Full(r.cwd) + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Runtime must be separate from task data");
            ValidateTree(r.cwd); ValidateTree(r.runtimeDirectory);
            registrySid=RegistryReadCapability();
            capabilityList=Allocate(new SidAndAttributes { sid=registrySid, attributes=4 });
            profileAttempted=true;
            int hr = CreateAppContainerProfile(profile, profile, "WhaleLife isolated task", capabilityList, 1, out sid);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr); owned = true;
            result.profileId=profile;
            identity = new SecurityIdentifier(sid);
            IntPtr profilePath;
            hr = GetAppContainerFolderPath(identity.Value, out profilePath);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            try { profileDirectory = Marshal.PtrToStringUni(profilePath); } finally { Marshal.FreeCoTaskMem(profilePath); }
            Grant(r.cwd, identity, FileSystemRights.Modify);
            Grant(r.runtimeDirectory, identity, FileSystemRights.ReadAndExecute);
            SecurityAttributes sa = new SecurityAttributes { length=Marshal.SizeOf(typeof(SecurityAttributes)), inherit=true };
            Check(CreatePipe(out outRead, out outWrite, ref sa, 0), "Create stdout pipe");
            Check(CreatePipe(out errRead, out errWrite, ref sa, 0), "Create stderr pipe");
            Check(CreatePipe(out inRead, out inWrite, ref sa, 0), "Create stdin pipe");
            Check(SetHandleInformation(outRead,1,0), "Restrict stdout handle");
            Check(SetHandleInformation(errRead,1,0), "Restrict stderr handle");
            Check(SetHandleInformation(inWrite,1,0), "Restrict stdin handle");
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,4,0,ref size);
            attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,4,0,ref size),"Initialize sandbox attributes"); attributesInitialized=true;
            capabilityMemory=Allocate(new SecurityCapabilities { sid=sid, capabilities=capabilityList, count=1, reserved=0 });
            Attribute(attributes,0x00020009,capabilityMemory,Marshal.SizeOf(typeof(SecurityCapabilities)));
            policyMemory=Marshal.AllocHGlobal(4); Marshal.WriteInt32(policyMemory,1);
            Attribute(attributes,0x0002000f,policyMemory,4); // PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT
            handlesMemory=Marshal.AllocHGlobal(IntPtr.Size*3);
            Marshal.WriteIntPtr(handlesMemory,0,inRead); Marshal.WriteIntPtr(handlesMemory,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handlesMemory,IntPtr.Size*2,errWrite);
            Attribute(attributes,0x00020002,handlesMemory,IntPtr.Size*3);
            job=CreateJobObject(IntPtr.Zero,null); if (job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Create process job");
            JobExtendedLimits limits=new JobExtendedLimits(); limits.basic.flags=0x2000|0x8|0x100|0x200; limits.basic.activeProcessLimit=16;
            limits.processMemory=new UIntPtr(536870912); limits.jobMemory=new UIntPtr(1073741824);
            IntPtr limitsMemory=Allocate(limits);
            try { Check(SetInformationJobObject(job,9,limitsMemory,(uint)Marshal.SizeOf(typeof(JobExtendedLimits))),"Set job limits"); } finally { Marshal.FreeHGlobal(limitsMemory); }
            IntPtr uiMemory=Marshal.AllocHGlobal(4); Marshal.WriteInt32(uiMemory,0xff);
            try { Check(SetInformationJobObject(job,4,uiMemory,4),"Set job desktop restrictions"); } finally { Marshal.FreeHGlobal(uiMemory); }
            // Windows 10+: bind during CreateProcess, closing the create/assign crash gap.
            // There is deliberately no fallback to post-creation AssignProcessToJobObject.
            jobListMemory=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobListMemory,job);
            Attribute(attributes,0x0002000d,jobListMemory,IntPtr.Size);
            string systemRoot=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            SortedDictionary<string,string> variables=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            variables["SystemRoot"]=systemRoot; variables["WINDIR"]=systemRoot;
            variables["ComSpec"]=Path.Combine(systemRoot,"System32","cmd.exe");
            variables["PATH"]=r.runtimeDirectory+";"+Path.Combine(systemRoot,"System32")+";"+Path.Combine(systemRoot,"System32","WindowsPowerShell","v1.0");
            variables["TEMP"]=r.cwd; variables["TMP"]=r.cwd; variables["USERPROFILE"]=r.cwd;
            variables["LOCALAPPDATA"]=profileDirectory; variables["APPDATA"]=profileDirectory;
            variables["NODE_SKIP_PLATFORM_CHECK"]="1";
            StringBuilder envText=new StringBuilder(); foreach (KeyValuePair<string,string> pair in variables) envText.Append(pair.Key).Append('=').Append(pair.Value).Append('\0'); envText.Append('\0');
            environment=Marshal.StringToHGlobalUni(envText.ToString());
            StartupInfoEx startup=new StartupInfoEx(); startup.info.cb=Marshal.SizeOf(typeof(StartupInfoEx)); startup.info.flags=0x100; startup.info.stdin=inRead; startup.info.stdout=outWrite; startup.info.stderr=errWrite; startup.attributes=attributes;
            StringBuilder command=new StringBuilder(Quote(r.executable)); foreach (string arg in r.arguments) command.Append(' ').Append(Quote(arg));
            Check(CreateProcess(r.executable,command,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x4|0x400|0x08000000,environment,r.cwd,ref startup,out process),"Create LPAC process"); launched=true;
#if WHALELIFE_TEST_FAULTS
            if (r.testFault=="pause-after-create") {
                Console.WriteLine(new JavaScriptSerializer().Serialize(new { testStage="created", pid=process.pid, profileId=profile }));
                Console.Out.Flush(); Thread.Sleep(60000);
            }
#endif
            IntPtr token; Check(OpenProcessToken(process.process,8,out token),"Verify AppContainer token");
            try {
                IntPtr info=Marshal.AllocHGlobal(4); int required;
                try { Check(GetTokenInformation(token,29,info,4,out required),"Query AppContainer token"); if (Marshal.ReadInt32(info)!=1) throw new InvalidOperationException("AppContainer token missing"); }
                finally { Marshal.FreeHGlobal(info); }
                GetTokenInformation(token,30,IntPtr.Zero,0,out required);
                if (required<4 || required>65536) throw new InvalidOperationException("Invalid token capability list");
                info=Marshal.AllocHGlobal(required);
                try {
                    Check(GetTokenInformation(token,30,info,required,out required),"Query token capabilities");
                    if (Marshal.ReadInt32(info)!=1) throw new InvalidOperationException("Unexpected sandbox capability count");
                    SidAndAttributes tokenCapability=(SidAndAttributes)Marshal.PtrToStructure(new IntPtr(info.ToInt64()+IntPtr.Size),typeof(SidAndAttributes));
                    if (!new SecurityIdentifier(tokenCapability.sid).Equals(new SecurityIdentifier(registrySid))) throw new InvalidOperationException("Unexpected sandbox capability SID");
                }
                finally { Marshal.FreeHGlobal(info); }
            } finally { CloseHandle(token); }
            Close(ref outWrite); Close(ref errWrite); Close(ref inRead); Close(ref inWrite);
            CaptureBudget budget=new CaptureBudget(r.maxOutputBytes);
            output=new Capture(outRead,budget); outRead=IntPtr.Zero;
            error=new Capture(errRead,budget); errRead=IntPtr.Zero;
            outThread=new Thread(output.Read); outThread.IsBackground=true;
#if WHALELIFE_TEST_FAULTS
            if (r.testFault=="thread-start") throw new InvalidOperationException("Injected output thread startup failure");
#endif
            outThread.Start();
            errThread=new Thread(error.Read); errThread.IsBackground=true; errThread.Start();
            Thread control=new Thread(delegate() { try { Console.ReadLine(); } catch { } Interlocked.Exchange(ref cancelRequested,1); }); control.IsBackground=true; control.Start();
            if (ResumeThread(process.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(),"Resume isolated process");
            while (true) {
                uint waited=WaitForSingleObject(process.process,25);
                if (waited==0) { result.status="completed"; break; }
                if (waited==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(),"Wait isolated process");
                if (Interlocked.CompareExchange(ref cancelRequested,0,0)!=0) { result.status="cancelled"; break; }
                if (watch.ElapsedMilliseconds>=r.timeoutMs) { result.status="timeout"; break; }
            }
            uint code;
            if (result.status=="completed") { Check(GetExitCodeProcess(process.process,out code),"Get process exit code"); result.exitCode=code; }
            Check(TerminateJobObject(job,0xc000013a),"Terminate remaining task processes");
            WaitForSingleObject(process.process,5000);
        } catch (Exception ex) {
            result.status=launched ? "failed" : "unavailable";
            Win32Exception win=ex as Win32Exception;
            result.reason=win==null ? ex.GetType().Name+": "+ex.Message : win.Message+" (Win32 "+win.NativeErrorCode+")";
        } finally {
            List<string> failures=new List<string>();
            CleanupStep("job termination",delegate() {
                if (job!=IntPtr.Zero) { Check(TerminateJobObject(job,0xc000013a),"Terminate job"); if (!WaitJobEmpty(job)) throw new InvalidOperationException("Task tree did not stop"); }
            },failures);
            CleanupStep("process termination",delegate() { if (process.process!=IntPtr.Zero) { TerminateProcess(process.process,0xc000013a); if (WaitForSingleObject(process.process,5000)!=0) throw new InvalidOperationException("Task process did not stop"); } },failures);
            CleanupStep("process handles",delegate() { Close(ref process.thread); Close(ref process.process); Close(ref job); },failures);
            CleanupStep("pipe handles",delegate() { Close(ref outWrite); Close(ref errWrite); Close(ref inRead); Close(ref inWrite); Close(ref outRead); Close(ref errRead); },failures);
            CleanupStep("stdout reader",delegate() { JoinReader(outThread); },failures);
            CleanupStep("stderr reader",delegate() { JoinReader(errThread); },failures);
            CleanupStep("capture streams",delegate() { if (output!=null) output.Close(); if (error!=null) error.Close(); },failures);
            CleanupStep("captured output",delegate() {
                if (output!=null) { result.stdout=output.Text(); result.truncated=output.truncated; }
                if (error!=null) { result.stderr=error.Text(); result.truncated=result.truncated||error.truncated; }
            },failures);
            CleanupStep("process attributes",delegate() { if (attributesInitialized) DeleteProcThreadAttributeList(attributes); },failures);
            foreach (IntPtr allocation in new IntPtr[] { attributes,capabilityMemory,policyMemory,handlesMemory,environment,registrySid,capabilityList,jobListMemory }) {
                IntPtr current=allocation;
                CleanupStep("native allocation",delegate() { if (current!=IntPtr.Zero) Marshal.FreeHGlobal(current); },failures);
            }
            if (!profileAttempted) result.profileDeleted=true;
            if (owned) {
                CleanupStep("task ACL",delegate() { RemoveGrant(r.cwd,identity); },failures);
                CleanupStep("runtime ACL",delegate() { RemoveGrant(r.runtimeDirectory,identity); },failures);
                CleanupStep("AppContainer profile",delegate() {
#if WHALELIFE_TEST_PROFILE_CLEANUP_FAILURE
                    throw new InvalidOperationException("Injected profile cleanup failure");
#else
                    int deleted=DeleteAppContainerProfile(profile);
                    if (deleted!=0) { Thread.Sleep(100); deleted=DeleteAppContainerProfile(profile); }
                    result.profileDeleted=deleted==0 && (profileDirectory==null || !Directory.Exists(profileDirectory));
                    if (!result.profileDeleted) throw new InvalidOperationException("Profile cleanup incomplete");
#endif
                },failures);
            }
            CleanupStep("profile SID",delegate() { if (sid!=IntPtr.Zero) FreeSid(sid); },failures);
            if (failures.Count>0 || !result.profileDeleted) {
                result.status="failed";
                result.reason=(result.reason==null ? "" : result.reason+"; ")+"Cleanup incomplete: "+String.Join(", ",failures.ToArray());
            }
            result.elapsedMs=watch.ElapsedMilliseconds;
        }
        return result;
    }
    public static int Main() {
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
        JavaScriptSerializer json=new JavaScriptSerializer(); json.MaxJsonLength=1048576;
        Result result;
        try {
            string line=Console.ReadLine(); if (line==null || line.Length>524288) throw new InvalidOperationException("Invalid request envelope");
            Request request=json.Deserialize<Request>(line);
#if WHALELIFE_TEST_FAULTS
            if (request.testCleanupProfile!=null) {
                if (!System.Text.RegularExpressions.Regex.IsMatch(request.testCleanupProfile,"^WhaleLife\\.Computer\\.[0-9a-f]{32}$")) throw new InvalidOperationException("Invalid fixture profile");
                int deleted=DeleteAppContainerProfile(request.testCleanupProfile);
                Console.WriteLine(json.Serialize(new { testCleanup=deleted==0 })); return deleted==0 ? 0 : 1;
            }
#endif
            result=Run(request);
        }
        catch (Exception) { result=new Result { status="failed",reason="Sandbox broker failed before verified completion; resource cleanup is uncertain",profileDeleted=false }; }
        try { Console.WriteLine(json.Serialize(result)); } catch (IOException) { return 2; }
        return 0;
    }
}
