# Windows execution broker

`SandboxRunner.cs` is the trusted native broker for isolated command execution.
Build it with the installed .NET Framework compiler from the repository root:

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll /out:native\SandboxRunner.exe native\SandboxRunner.cs
```

No compiler/runtime download is performed. `SandboxRunner.exe` is a generated
distribution artifact, not source to commit. Production tasks require a built helper.
`probe()` checks files only; it does not create a profile or claim every runtime works.

Each execution creates a unique profile owned by that invocation, supplies no
network capability SIDs, and enables Less Privileged AppContainer (LPAC) to exclude grants
to ALL APPLICATION PACKAGES. It grants only the task snapshot Modify access and
the separate copied runtime ReadAndExecute access. Windows runtime resources
already available to LPAC remain available. No firewall or global filesystem ACL
changes are made. The broker never grants access to original user files.

The only capability supplied is `registryRead`, needed for Windows Winsock runtime
initialization even when Node does not use a network. Microsoft describes this
capability as HKLM read access; existing resource ACLs still apply. The broker
checks the child token contains exactly this SID before resuming it. Synthetic
HKCU private-key and external-file denial tests accompany the network denial tests.

The child starts suspended with a Windows 10+ creation-time JOB_LIST attribute
that binds it to a Job with no breakaway and KILL_ON_JOB_CLOSE. It is resumed only
after AppContainer token verification. There is no post-creation assignment fallback.
Only its three standard stream handles and a minimal environment are inherited.
Output is continuously drained with a shared byte budget. Explicit cancellation,
stdin EOF, timeout, and ordinary completion terminate remaining descendants.

After processes and handles close, the broker removes its task ACL entries,
calls DeleteAppContainerProfile, and checks that its returned profile folder no
longer exists. This does not claim to independently enumerate every internal
Windows registry object. Cleanup failure is returned as failure, never success.
Abruptly killing the broker closes the Job, but profile cleanup is then uncertain
and must not be reported as complete. Test only with synthetic inputs.
Cleanup phases are isolated so an output-thread or handle-cleanup failure cannot
skip profile deletion. Unverified cleanup defaults to false, and a validated
random profile identifier is preserved when available. Failure-injection code and
its profile-cleanup entry point exist only in test builds compiled with explicit
test symbols; the production helper contains neither.

PowerShell is offered as a local runtime candidate; it may be unavailable in LPAC
on a particular Windows installation. No COM/network capabilities or unrestricted
fallback are added to make it work. On the validated Windows 11 build, Windows
PowerShell did not start under this policy. Node code can launch accessible local
commands under the same policy using `stdio: 'inherit'`. Node's default Windows
child-process pipe setup is incompatible with this LPAC boundary and can stall;
the task timeout still terminates its Job. Do not interpret that as a command
having run. Node main-module loading avoids an unnecessary realpath walk through
volume ancestors; all actual file opens remain subject to LPAC.

Official contracts:

- [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
- [CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)
- [DeleteAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile)
- [Process attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
