/* ************************************************************************
 * Copyright (c) 1998-2026 Broadcom. All Rights Reserved.
 * Broadcom Confidential. The term "Broadcom" refers to Broadcom Inc.
 * and/or its subsidiaries.
 * ************************************************************************/

// VMware support script, javascript version.
// Collects various configuration and log files for troubleshooting
// VMware Workstation or VMware Player.

var HKLM = 0x80000002;
var COMMON_APPDATA = 0x23;
var USER_APPDATA = 0x1A;
var PROGRAM_FILES = 0x26;
var WINDOWS_DIR = 0x24;

var REG_SZ = 1;
var REG_EXPAND_SZ = 2;
var REG_BINARY = 3;
var REG_DWORD = 4;

var COMMUNITY_FORUM_URL = "https://community.broadcom.com/";


var ONE_INSTANCE_ONLY = "Please make sure only one instance of"
                          + " vm-support.js is running at a time.";

var quietMode = false;
var outputFile = "";
var outputFolder = "";
var collectOnlyUILogs = false;
var collectLogsForVMs = false;
var collectStateLogs = false;

// Set to True to debug the support script itself.
var debugScript = false;

function Quote(strin) {
    return "\"" + strin + "\"";
}

function NeedQuote(strin) {
    return strin.search(" ") !== -1;
}

function FormatArguments() {
    var args = WScript.Arguments;
    var s = "";
    for (var i = 0; i < args.length; i++) {
        if (NeedQuote(args(i))) {
            s = s + " " + Quote(args(i));
        } else {
            s = s + " " + args(i);
        }
    }
    return s;
}

function LeftPadFrom(template, object) {
    var s = object.toString();
    if (s.length >= template.length) {
        return s;
    }
    return template.slice(0, -s.length) + s;
}

function Timestamp() {
    var date = new Date();
    var month = LeftPadFrom("00", date.getMonth() + 1);
    var day = LeftPadFrom("00", date.getDate());
    var hour = LeftPadFrom("00", date.getHours());
    var minute = LeftPadFrom("00", date.getMinutes());
    var year = date.getFullYear().toString();
    return [year, month, day, hour, minute].join("-");
}

function VMsupport() {
    this.Fso = WScript.CreateObject("Scripting.FileSystemObject");

    var scriptDir = WScript.ScriptFullName.slice(0, -WScript.ScriptName.length)
    this.sevenZipExe = scriptDir + "7za.exe";
    if (!this.Fso.FileExists(this.sevenZipExe)) {
        WriteLine("File not found: " + this.sevenZipExe);
        WriteLine("");
        WriteLine("Cannot generate a support bundle.");
        WScript.Quit(0);
    }

    this.RegObj = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\"
                            + ".\\root\\default:StdRegProv");
    var objWMI = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\"
                           + ".\\root\\cimv2");
    var colItems = objWMI.ExecQuery("SELECT * FROM Win32_OperatingSystem",
                                    "WQL",
                                    objWMI.wbemFlagReturnImmediately);

    // Getting the version number for the OS (could be used later)
    this.osVersion = colItems.ItemIndex(colItems.Count - 1).Version;
    // Splitting the OS version into major minor and service pack if needed in future
    this.versionInfo = this.osVersion.split(".");
    this.majorVersion = Number(this.versionInfo[0]);
    this.minorVersion = Number(this.versionInfo[1]);
    // AddressWidth parameter in Win32_Processor class query
    // for finding if OS is 64bit or 32bit
    this.archVersion = GetObject("winmgmts:root\\cimv2:"
                                 + "Win32_Processor='cpu0'").AddressWidth;

    this.Wsh = WScript.CreateObject("WScript.Shell");
    var wshNetwork = WScript.CreateObject("WScript.Network");
    this.Username = wshNetwork.UserName;
    this.tmpdir = this.Wsh.Environment("Process").Item("Temp");
    this.SysTemp = this.Wsh.Environment("Process").Item("WINDIR") + "\\Temp";
    this.SysTemp_VmwareSys = this.SysTemp + "\\vmware-system";
    this.Minidump = this.Wsh.Environment("Process").Item("WINDIR") + "\\Minidump";
    this.AllUsersProfile = this.Wsh.Environment("Process").Item("ALLUSERSPROFILE");
    if (outputFolder === "") {
        this.vmtmpdir = this.tmpdir + "\\vmware-support";
    } else {
        this.vmtmpdir = outputFolder;
    }
    if (!this.Fso.FolderExists(this.vmtmpdir)) {
        this.Fso.CreateFolder(this.vmtmpdir);
    }
    this.workdir = this.vmtmpdir + "\\vmsupport-" + Timestamp();
    if (this.Fso.FolderExists(this.workdir)) {
        try {
            this.Fso.DeleteFolder(this.workdir, true);
        } catch (err) {
            if (!quietMode) {
                WriteLine("");
                WriteLine(" Could not delete folder " + this.workdir + ". "
                          + ONE_INSTANCE_ONLY);
            }
            WScript.Quit(0);
        }
    }
    this.VMList = {};
    this.Fso.CreateFolder(this.workdir);
    this.Fso.CreateFolder(this.workdir + "\\Misc");
    this.Fso.CreateFolder(this.workdir + "\\Dumps");
    this.Fso.CreateFolder(this.workdir + "\\VM");
    this.Fso.CreateFolder(this.workdir + "\\TEMP");
    this.Fso.CreateFolder(this.workdir + "\\Global_Config");
    this.Fso.CreateFolder(this.workdir + "\\SYSTEMP");
    this.Fso.CreateFolder(this.workdir + "\\SYSTEMP\\vmware-system");
    this.Fso.CreateFolder(this.workdir + "\\MiniDump");
    this.Fso.CreateFolder(this.workdir + "\\DxDiag");
    var objShell = WScript.CreateObject("Shell.Application");
    this.AppData = objShell.NameSpace(COMMON_APPDATA).Self.Path;
    this.UserData = objShell.NameSpace(USER_APPDATA).Self.Path;
    this.WindowsDir = objShell.Namespace(WINDOWS_DIR).Self.Path;
    this.ProgFiles = objShell.Namespace(PROGRAM_FILES).Self.Path;
}

VMsupport.prototype.DumpKey = function(DefKey, Path, filename) {
    var f;

    try {
        f = this.Fso.CreateTextFile(filename, true, true);
    } catch (err) {
        if (!quietMode) {
            WriteLine("");
            WriteLine("Could not create text file " + filename + ". "
                      + ONE_INSTANCE_ONLY);
        }
        WScript.Quit(0);
    }
    this.EnumerateKey(DefKey, Path, f);
    f.Close();
};

// Recursively enumerate registry and write it to a file.
VMsupport.prototype.EnumerateKey = function(DefKey, Path, OutFile) {
    var i, names;
    OutFile.WriteLine("[" + Path + "]");
    var outparams = this.GetRegistryEnumValues(DefKey, Path);

    function SerializeName(name) {
        return (name === null) ? "@" : Quote(name);
    }

    if (outparams.ReturnValue === 0
        && outparams.sNames !== null
        && outparams.Types !== null) {
        names = outparams.sNames.toArray();
        var types = outparams.Types.toArray();
        for (i = 0; i < types.length; i++) {
            var value;
            switch (types[i]) {
                case REG_SZ:
                    value = this.GetRegistryStringValue(DefKey,
                                                        Path,
                                                        names[i]);
                    if (names[i] !== null || value !== null) {
                        OutFile.WriteLine([SerializeName(names[i]),
                                           "=",
                                           Quote(value)].join(""));
                    }
                    break;
                case REG_EXPAND_SZ:
                    value = this.GetRegistryExpandedStringValue(DefKey,
                                                                Path,
                                                                names[i]);
                    if (names[i] !== null || value !== null) {
                        OutFile.WriteLine([SerializeName(names[i]),
                                           "=expand:",
                                           Quote(value)].join(""));
                    }
                    break;
                case REG_BINARY:
                    value = this.GetRegistryBinaryValue(DefKey,
                                                        Path,
                                                        names[i]);
                    for (var j = 0; j < value.length; j++) {
                        value[j] = LeftPadFrom("00", value[j].toString(16));
                    }
                    if (names[i] !== null || value !== null) {
                        OutFile.WriteLine([SerializeName(names[i]),
                                           "=hex:",
                                           value.join(",")].join(""));
                    }
                    break;
                case REG_DWORD:
                    value = this.GetRegistryDWORDValue(DefKey,
                                                       Path,
                                                       names[i]);
                    if (names[i] !== null || value !== null) {
                        OutFile.WriteLine([
                            SerializeName(names[i]),
                            "=dword:",
                            LeftPadFrom("00000000",
                                        value.toString(16))].join(""));
                    }
            }
        }
    }

    OutFile.WriteLine();
    names = this.GetRegistryEnumKey(DefKey, Path);
    var NewPath;
    if (names !== null) {
        for (i = 0; i < names.length; i++) {
            NewPath = Path + "\\" + names[i];
            this.EnumerateKey(DefKey, NewPath, OutFile);
        }
    }
};

VMsupport.prototype.TryCopyFolder = function(src, dst) {
    try {
        this.Fso.CopyFolder(src, dst);
    } catch (error) {}
};

VMsupport.prototype.TryCopyFile = function(src, dst) {
    try {
        this.Fso.CopyFile(src, dst);
    } catch (error) {}
};

// Run a command and save the output to a file
VMsupport.prototype.RunCmd = function(cmd, outfile) {
    var f;
    try {
        f = this.Fso.CreateTextFile(outfile, true, true);
    } catch (err) {
        if (!quietMode) {
            WriteLine("");
            WriteLine("Could not create text file " + outfile + ". "
                      + ONE_INSTANCE_ONLY);
        }
        WScript.Quit(0);
    }

    if (debugScript) {
        WriteLine("Executing: " + cmd);
    }
    try {
        var run = this.Wsh.Exec(cmd);
        var output = run.StdOut.ReadAll();
        f.Write(output);
    } catch (error) {}
    f.Close();
};

VMsupport.prototype.CopyConfig = function() {
    var myFoldersObj = this.Fso.GetFolder(this.AppData + "\\VMware");
    var folder = new Enumerator(myFoldersObj.SubFolders);
    for (; !folder.atEnd(); folder.moveNext()) {
        var folderName = this.Fso.GetFileName(folder.item());
        this.CopyFolder(this.AppData + "\\VMware\\" + folderName,
                        this.workdir + "\\Global_Config\\" + folderName);
    }

    this.TryCopyFolder(this.UserData + "\\VMware",
                       this.workdir + "\\Current_User");
    // The UI Log
    this.TryCopyFile(this.tmpdir + "\\vmware-" + this.Username
                     + "\\vmware*.log",
                     this.workdir + "\\Temp\\");
    // The Installer Logs
    this.TryCopyFile(this.SysTemp + "\\vminst.log",
                     this.workdir + "\\SYSTEMP\\");
    this.TryCopyFile(this.tmpdir + "\\vm*.log", this.workdir + "\\Temp\\");
    this.TryCopyFile(this.SysTemp + "\\vmware*.log",
                     this.workdir + "\\SYSTEMP\\");
    this.TryCopyFile(this.WindowsDir + "\\setupapi.log",
                      this.workdir + "\\SYSTEMP\\");
    this.TryCopyFile(this.WindowsDir + "\\inf\\setupapi.dev.log",
                     this.workdir + "\\SYSTEMP\\");
    this.TryCopyFile(this.WindowsDir + "\\inf\\setupapi.offline.log",
                     this.workdir + "\\SYSTEMP\\");
    this.TryCopyFile(this.WindowsDir + "\\inf\\setupapi.app.log",
                     this.workdir + "\\SYSTEMP\\");
};

// Copy dump files
VMsupport.prototype.CopyDumpFiles = function() {
    var appDirs = [
        this.GetUserProfileDirectory("Default User") + "\\Application Data",
        this.GetUserProfileDirectory("Default User")
        + "\\Local Settings\\Application Data",
        this.GetUserProfileDirectory("LocalService") + "\\Application Data",
        this.GetUserProfileDirectory("NetworkService")
        + "\\Application Data",
        this.GetUserProfileDirectory("NetworkService")
        + "\\Local Settings\\Application Data"
    ];
    for (var i = 0; i < appDirs.length; i++) {
        this.TryCopyFile(appDirs[i] + "\\VMware\\*.dmp",
                         this.workdir + "\\Dumps\\");
    }
};

VMsupport.prototype.CopyEventLogs = function() {
    this.CopyLog("Application", this.workdir + "\\Misc\\");
    this.CopyLog("System", this.workdir + "\\Misc\\");
    this.CopyLog("Security", this.workdir + "\\Misc\\");
};

// Delete files with sensitive data
// Currently we delete the SSL folder to avoid collecting
// the private or public keys.
VMsupport.prototype.PurgeFiles = function() {
    try {
        this.Fso.DeleteFolder(this.workdir + "\\Global_Config\\VMware Server\\SSL");
    } catch (err) {}
};

// Copy the specified system event log to the specified directory
VMsupport.prototype.CopyLog = function(logName, directory) {
    // non-admin users would lack permissions
    var query1 = "winmgmts:{impersonationLevel=impersonate,"
                 + "(Backup,Security)}!\\\\.\\root\\cimv2";
    var query2 = "SELECT * FROM Win32_NTEventLogFile WHERE "
                 + "LogfileName='" + logName + "'";

    var logFileSet = GetObject(query1).ExecQuery(query2);

    var logFileObj = new Enumerator(logFileSet);
    for (; !logFileObj.atEnd(); logFileObj.moveNext()) {
       logFileObj.item().BackupEventLog(directory + logName + "-log.evt");
    }
};

VMsupport.prototype.CopyMinidump = function() {
    var lastModTime1, lastModFile1; // File modified last but one
    var lastModTime2, lastModFile2; // File modified last

    lastModTime1 = new Date(0);
    lastModTime2 = new Date(0);
    lastModFile1 = "";
    lastModFile2 = "";

    var dumpFolder;
    try {
        dumpFolder = this.Fso.GetFolder(this.Minidump);
    } catch (err) {
        return;
    }
    var myDumpFiles = new Enumerator(dumpFolder.Files);
    for (; !myDumpFiles.atEnd(); myDumpFiles.moveNext()) {
        var fileobj = myDumpFiles.item();
        if (this.Fso.GetExtensionName(myDumpFiles.item()).toUpperCase() === "DMP") {
            var lastModDate = new Date(fileobj.DateLastModified);
            if (lastModDate > lastModTime2) {
                lastModFile1 = lastModFile2;
                lastModTime1 = lastModTime2;
                lastModFile2 = myDumpFiles.item().Name;
                lastModTime2 = lastModDate;
            } else if (lastModDate > lastModTime1) {
                lastModFile1 = myDumpFiles.item().Name;
                lastModTime1 = lastModDate;
            }
        }
    }

    if (lastModFile1 !== "") {
        this.TryCopyFile(this.Minidump + "\\" + lastModFile1,
                         this.workdir + "\\Minidump\\");
        if (!quietMode) {
            Write(".");
        }
    }

    if (lastModFile2 !== "") {
        this.TryCopyFile(this.Minidump + "\\" + lastModFile2,
                         this.workdir + "\\Minidump\\");
        if (!quietMode) {
            Write(".");
        }
    }
};

VMsupport.prototype.CopyVmwareSystemFiles = function() {
    var dumpFolder = this.Fso.GetFolder(this.SysTemp_VmwareSys);
    var myDumpFiles = new Enumerator(dumpFolder.Files);
    for (; !myDumpFiles.atEnd(); myDumpFiles.moveNext()) {
        var dumpFile = myDumpFiles.item();
        this.TryCopyFile(this.SysTemp_VmwareSys + "\\" + dumpFile,
                         this.workdir + "\\SYSTEMP\\vmware-system\\");
        if (!quietMode) {
            Write(".");
        }
    }
};

VMsupport.prototype.StdRegProvGetFunc = function(FuncName, DefKey, Path, ValName) {
    var method = this.RegObj.Methods_.Item(FuncName);
    var inparams = method.InParameters.SpawnInstance_();
    inparams.hDefKey = DefKey;
    inparams.sSubKeyName = Path;
    inparams.sValueName = ValName;
    var outparams = this.RegObj.ExecMethod_(FuncName, inparams);
    return outparams;
};

VMsupport.prototype.StdRegProvEnumFunc = function(FuncName, DefKey, Path) {
    var method = this.RegObj.Methods_.Item(FuncName);
    var inparams = method.InParameters.SpawnInstance_();
    inparams.hDefKey = DefKey;
    inparams.sSubKeyName = Path;
    var outparams = this.RegObj.ExecMethod_(FuncName, inparams);
    return outparams;
};

VMsupport.prototype.GetRegistryDWORDValue = function(key, path, valueName) {
    return this.StdRegProvGetFunc("GetDWORDValue", key, path, valueName).uValue;
};

VMsupport.prototype.GetRegistryStringValue = function(key, path, valueName) {
    return this.StdRegProvGetFunc("GetStringValue", key, path, valueName).sValue;
};

VMsupport.prototype.GetRegistryBinaryValue = function(key, path, valueName) {
    return this.StdRegProvGetFunc("GetBinaryValue", key, path, valueName).uValue.toArray();
};

VMsupport.prototype.GetRegistryExpandedStringValue = function(key, path, valueName) {
    return this.StdRegProvGetFunc("GetExpandedStringValue", key, path, valueName).sValue;
};

VMsupport.prototype.GetRegistryEnumValues = function(key, path) {
    return this.StdRegProvEnumFunc("EnumValues", key, path);
};

VMsupport.prototype.GetRegistryEnumKey = function(key, path) {
    var names = this.StdRegProvEnumFunc("EnumKey", key, path).sNames;
    return names === null ? null : names.toArray();
};

VMsupport.prototype.GetDictionaryValue = function(dictionaryLine) {
    return dictionaryLine.split("\"")[1];
};

// Return the path to the user profile directory of the specified user
VMsupport.prototype.GetUserProfileDirectory = function(userName) {
    var strKeyPath, strValueName, strValue;
    strKeyPath = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"
                 + "\\ProfileList";
    strValueName = "ProfilesDirectory";
    strValue = this.GetRegistryExpandedStringValue(HKLM,
                                                   strKeyPath,
                                                   strValueName);
    if (strValue !== null) {
        strValue = strValue + "\\" + this.Username;
    }
    return strValue;
};

// Search only one level of folders for vmx files.
VMsupport.prototype.FindAllFoldersWithVMX = function(directory) {
    var subfolder, file;
    if (this.Fso.FolderExists(directory)) {
        subfolder = this.Fso.GetFolder(directory);
        var subfolderIter = new Enumerator(subfolder.SubFolders);
        for (; !subfolderIter.atEnd(); subfolderIter.moveNext()) {
            file = subfolderIter.item() + "\\v.vmx";
            this.VMList[file] = "";
        }
    }
};

String.prototype.trim = function() {
    return this.replace(/^\s+|\s+$/g, '');
};

String.prototype.endsWith = function(suffix) {
    return this.slice(-suffix.length) === suffix;
};

String.prototype.startsWith = function(prefix) {
    return this.slice(0, prefix.length) === prefix;
};

VMsupport.prototype.UpdateVMList = function(file, regex) {
    if (!this.Fso.FileExists(file)) {
        return;
    }

    var data = this.Fso.OpenTextFile(file).ReadAll();
    var matches = data.match(regex);
    if (matches === null) {
        return;
    }

    for (var m = 0; m < matches.length; m++) {
        file = this.GetDictionaryValue(matches[m]);
        this.VMList[file] = "";
    }
};

// Search for all VMs. The real work is done in CopyVM
VMsupport.prototype.CopyVMs = function() {
    if (collectOnlyUILogs) {
        return;
    }

    if (collectLogsForVMs) {
        for (var i = 0; i < WScript.Arguments.length; i++) {
            if (WScript.Arguments(i) === "-v"
                && i + 1 < WScript.Arguments.length) {
                var nextarg = WScript.Arguments(i + 1);
                var files = nextarg.split("|");
                for (var iter = 0; iter < files.length; iter++) {
                    var file = files[iter].trim();
                    if (!file.toLowerCase().endsWith(".vmx")) {
                        // Looks like we got the vmx file path
                        file = file + "\\v.vmx";
                    }
                    this.VMList[file] = "";
                }
            }
        }
    } else {
        this.UpdateVMList(this.UserData + "\\VMware\\preferences.ini",
                          /^pref[.]ws[.]session[.]window\d+[.]tab\d+[.]file\s*=.*$/gi);
        this.UpdateVMList(this.UserData + "\\VMware\\inventory.vmls",
                          /vmlist\d+\.config\s*=.*\n/gi);
    }

    for (var property in this.VMList) {
        if (this.Fso.FileExists(property)
            || this.ContainsVmxFile(this.Fso.GetParentFolderName(property))) {
            this.CopyVM(property);
        }
    }
};

VMsupport.prototype.CopyFolder = function(source, dest) {
    // create dest if it does not exist
    if (!this.Fso.FolderExists(dest)) {
        this.Fso.CreateFolder(dest);
    }
    // Copy each file in the directory
    var file = new Enumerator(this.Fso.GetFolder(source).Files);
    for (; !file.atEnd(); file.moveNext()) {
        var tmpf = String(file.item()).toLowerCase();
        // Let's keep this as a whitelist for now.
        if (tmpf.endsWith(".log") ||
            tmpf.endsWith(".log.gz") ||
            tmpf.endsWith(".ini") ||
            tmpf.endsWith(".xml")) {
            this.Fso.CopyFile(tmpf, dest + "\\");
        }
    }

    if (!quietMode) {
        Write(".");
    }
    // Copy each directory in this directory
    var myFolders = new Enumerator(this.Fso.GetFolder(source).SubFolders);
    for (; !myFolders.atEnd(); myFolders.moveNext()) {
        var folder = this.Fso.GetFileName(myFolders.item());
        this.CopyFolder(source + "\\" + folder,
                        dest + "\\" + folder);
    }
};

// Save files less than 30K or the log file.
// Monitor logs will be in a subdirectory eventually.
VMsupport.prototype.CopyVM = function(vmx) {
    var filename;
    var src = this.Fso.GetParentFolderName(vmx);
    // Set the destination dir to be the VM folder name.
    // If there are more than one VMs with the same folder name
    // we add a "-1", "-2" etc as the suffix.
    var dst = this.workdir + "\\VM\\" + this.Fso.GetFolder(src).Name;
    var baseDst = dst;
    var i = 1;
    while (this.Fso.FolderExists(dst)) {
        dst = baseDst + "-" + i;
        i++;
    }
    dst = dst + "\\";
    this.Fso.CreateFolder(dst);
    var f = new Enumerator(this.Fso.GetFolder(src).Files);
    for (; !f.atEnd(); f.moveNext()) {
        var absPath = String(f.item());
        // get file name from absolute path
        var pathComponents = absPath.split("\\");
        filename = pathComponents[pathComponents.length - 1].toLowerCase();
        if (this.Fso.GetFile(absPath).size < 30000
            || filename.endsWith(".vmpl")
            || filename.startsWith("stats")
            || filename.startsWith("gmon")
            || filename.startsWith("callstacks")
            || filename.startsWith("samples")
            || filename.startsWith("status")) {
            this.TryCopyFile(absPath, dst);
        } else if (filename.endsWith(".log")) {
            if (collectStateLogs) {
                this.TryCopyFile(absPath, dst);
            } else if (filename.search("state") === -1) {
                this.TryCopyFile(absPath, dst);
            }
        } else if (filename.endsWith(".dmp")) {
            this.TryCopyFile(absPath, dst);
        }
    }

    var myFld = this.Fso.GetFolder(src).SubFolders;
    var folder = new Enumerator(myFld);
    for (; !folder.atEnd(); folder.moveNext()) {
        filename = this.Fso.GetFileName(folder.item());
        if (filename.toLowerCase().endsWith("stats")) {
            this.TryCopyFolder(src + "\\" + filename, dst + "\\stats");
        }
    }

    this.RunCmd ("cacls " + Quote(src) + "\\*.*", dst + "cacls.txt");

    try {
        f = this.Fso.CreateTextFile(dst + "vmxpath.txt", true, true);
    } catch (err) {
        if (!quietMode) {
            WriteLine("");
            WriteLine("Could not create text file vmxpath.txt. "
                      + ONE_INSTANCE_ONLY);
        }
        WScript.Quit(0);
    }
    f.WriteLine(vmx);
    f.Close();

    if (!quietMode) {
        Write(".");
    }
};

// returns TRUE if there's a VMX file in the given directory
VMsupport.prototype.ContainsVmxFile = function(path) {
    if (!this.Fso.FolderExists(path)) {
        return false;
    }

    var ftmp = new Enumerator(this.Fso.GetFolder(path).Files);
    for (; !ftmp.atEnd(); ftmp.moveNext()) {
        var filename = ftmp.item().toLowerCase();
        if (filename.endsWith(".vmx")) {
            return true;
        }
    }
    return false;
};

// Save the MSinfo report, this takes a while and hence not saving text.
VMsupport.prototype.MSInfo = function() {
    var msinfo = this.Wsh.RegRead("HKLM\\SOFTWARE\\Microsoft\\Shared Tools"
                                  + "\\MSInfo\\Path");
    this.Wsh.Run(Quote(msinfo) + " /nfo " + this.workdir
                 + "\\Misc\\MSinfo.nfo", 0, true);
    if (!quietMode) {
        Write(".");
    }
};

VMsupport.prototype.Service = function() {
    var fp;
    try {
        fp = this.Fso.CreateTextFile(this.workdir + "\\Misc\\Service.txt",
                                     true, true);
    } catch (err) {
        if (!quietMode) {
            WriteLine("");
            WriteLine("Could not create text file Service.txt. "
                      + ONE_INSTANCE_ONLY);
        }
        WScript.Quit(0);
    }
    var wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!"
                        + "\\\\.\\root\\cimv2");
    var Services = wmi.ExecQuery("SELECT * FROM Win32_Service");
    var enumItems = new Enumerator(Services);
    var i = 0;
    for (; !enumItems.atEnd(); enumItems.moveNext()) {
        var s = enumItems.item();
        fp.WriteLine("System Name: " + s.SystemName);
        fp.WriteLine("Service Name: " + s.Name);
        fp.WriteLine("Service Type: " + s.ServiceType);
        fp.WriteLine("Service State: " + s.State);
        fp.WriteLine("ExitCode: " + s.ExitCode);
        fp.WriteLine("Process ID: " + s.ProcessID);
        fp.WriteLine("Accept Pause: " + s.AcceptPause);
        fp.WriteLine("Accept Stop: " + s.AcceptStop);
        fp.WriteLine("Caption: " + s.Caption);
        fp.WriteLine("Description: " + s.Description);
        fp.WriteLine("Desktop Interact: " + s.DesktopInteract);
        fp.WriteLine("Display Name: " + s.DisplayName);
        fp.WriteLine("Error Control: " + s.ErrorControl);
        fp.WriteLine("Path Name: " + s.PathName);
        fp.WriteLine("Started: " + s.Started);
        fp.WriteLine("StartMode: " + s.StartMode);
        fp.WriteLine("StartName: " + s.StartName);
        fp.Writeline();

        i++;
        if ((i % 4) === 0 && !quietMode) {
            Write(".");
        }
    }
    fp.Close();
};

VMsupport.prototype.BootIni = function() {
    var i = 0;
    while (true) {
        var bootdrive = String.fromCharCode("C".charCodeAt(0) + i);
        i++;
        var bootini = bootdrive + ":\\boot.ini";
        if (this.Fso.FileExists(bootini)) {
            var bootinidest, f;
            bootinidest = this.workdir + "\\Misc\\" + bootdrive + "_boot.ini";
            this.TryCopyFile(bootini, bootinidest);

            // Unset the hidden and system bits if set.
            try {
                f = this.Fso.GetFile(bootinidest);
            } catch (err) { }
            var readOnlyBit = 1 << 0;
            var hiddenBit = 1 << 1;
            var systemBit = 1 << 2;

            var unwantedBits = readOnlyBit | hiddenBit | systemBit;
            if (f.Attributes & unwantedBits) {
                f.Attributes &= ~unwantedBits;
            }
            // GetFile would fail if the boot.ini was not copied
            if (bootdrive === "C") {
                break;
            }
        }
        if (bootdrive === "Z") {
            break;
        }
    }
};

VMsupport.prototype.Generate = function() {
    if (!quietMode) {
        WriteLine("Collecting information needed for support. "
                  + "This may take several minutes.");
    }

    if (!quietMode) {
        Write("  Registry ");
    }
    this.DumpKey(HKLM, "SOFTWARE\\VMware, Inc.",
                 this.workdir + "\\Misc\\vmware_reg.txt");
    if (!quietMode) {
        Write("..");
    }
    this.DumpKey(HKLM, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"
          + "\\NetworkCards", this.workdir + "\\Misc\\networkcards_reg.txt");
    if (!quietMode) {
        WriteLine(".");
    }

    if (!quietMode) {
        Write("  DxDiag Data .");
    }
    this.Wsh.Run("dxdiag /t " + this.workdir + "\\DxDiag\\DxDiag.txt");

    if (!quietMode) {
        WriteLine(".");
    }

    if (!quietMode) {
        Write("  Driverquery .");
    }
    this.RunCmd("Driverquery /fo TABLE /V",
                this.workdir + "\\Misc\\Driverquery.txt");
    if (!quietMode) {
        WriteLine(".");
    }

    if (!quietMode) {
        Write("  Network Configuration .");
    }
    this.Fso.CopyFile(this.AppData + "\\VMware\\vmnet*.*" , this.workdir + "\\Misc");
    this.RunCmd("ipconfig /all", this.workdir + "\\Misc\\ipconfig.txt");
    this.RunCmd("route print", this.workdir + "\\Misc\\route.txt");
    if (!quietMode) {
        Write("..");
    }
    this.RunCmd("netstat -aens", this.workdir + "\\Misc\\netstat.txt");
    if (!quietMode) {
        Write("..");
    }
    this.RunCmd("netsh winsock show catalog",
           this.workdir + "\\Misc\\winsock_catalog.txt");
    if (!quietMode) {
        WriteLine("..");
    }

    if (!quietMode) {
        Write("  Startup Settings .");
    }
    this.BootIni();
    if (!quietMode) {
        WriteLine(".");
    }

    if (!quietMode) {
        Write("  VMware Configuration .");
    }
    this.CopyConfig();
    this.CopyDumpFiles();
    if (!quietMode) {
        WriteLine(".");
    }

    if (!quietMode) {
        Write("  Virtual Machines ");
    }
    this.CopyVMs();
    if (!quietMode) {
        WriteLine("");
    }

    if (!quietMode) {
        Write("  Services ");
    }
    this.Service();
    if (!quietMode) {
        WriteLine("");
    }

    if (!quietMode) {
        Write("  Dumps .");
    }
    this.CopyMinidump();
    this.CopyVmwareSystemFiles();
    if (!quietMode) {
        WriteLine("");
    }

    if (!quietMode) {
        Write("  System Information .");
    }
    this.MSInfo();
    if (!quietMode) {
        WriteLine(".");
    }

    if (!quietMode) {
        Write("  Logs .");
    }
    this.CopyEventLogs();
    if (!quietMode) {
        WriteLine("");
    }

    this.PurgeFiles();

    if (!quietMode) {
        WriteLine("");
    }

    var zipfile;
    if (outputFile === "") {
        zipfile = this.workdir + ".zip";
    } else {
        zipfile = outputFile;
        if (!zipfile.toLowerCase().endsWith(".zip")) {
            zipfile += ".zip";
        }
    }

    if (!quietMode) {
        WriteLine("Creating zip file...");
    }

    var zipLogFile = this.tmpdir + "\\vm-support-zip.log";
    this.RunCmd(
        [Quote(this.sevenZipExe),
         "a",
         "-tzip",
         Quote(zipfile),
         Quote(this.workdir)].join(" "),
        zipLogFile);

    if (!quietMode) {
        WriteLine("");
    }

    if (!this.Fso.FileExists(zipfile)) {
        WriteLine("There was an error creating the zip file.");
        WriteLine("If a file changed while reading, "
                  + "please run this script again.");
        WriteLine("Output log: " + zipLogFile)
        WriteLine("");
    } else {
        if (!quietMode) {
            WriteLine("Done!");
            WriteLine("");
        }
        WriteLine("Saved support data to " + zipfile);
        if (this.Fso.GetFile(zipfile).size > 10000000) {
            WriteLine("NOTE: " + zipfile + " is greater than 10 MB. ");
            WriteLine("Please do not attach this file when reporting an "
                      + "incident on the community forum. Please contact "
                      + "VMware support for an ftp site. To start a thread on "
                      + "the community forum, go to " + COMMUNITY_FORUM_URL);
        } else {
            WriteLine("Please attach this file when reporting an incident on "
                      + "the community forum. To start a thread on the "
                      + "community forum, go to " + COMMUNITY_FORUM_URL);
        }

        if (!quietMode) {
            WriteLine("");
        }

        // Open Windows Explorer in the right folder
        if (!quietMode) {
            this.Wsh.exec("explorer /n,/select," + zipfile);

            WriteLine("");
            WriteLine("");
        }
    }

    try {
        if (this.Fso.FolderExists(this.workdir)) {
            this.Fso.DeleteFolder(this.workdir, true);
        }
    } catch (error) {}
};


function Write(s) {
    try {
        WScript.StdOut.Write(s);
    } catch (err) { }
}

function WriteLine(s) {
    try {
        WScript.StdOut.WriteLine(s);
    } catch (err) { }
}

// If running with Wscript, relaunch with Cscript.
// This way people who double click directly on the script get the console and
// not a barrage of alert boxes.
function EnsureCscript() {
    if (!(/cscript[.]exe/.test(WScript.FullName))) {
        var Shell;
        Shell = WScript.CreateObject("WScript.Shell");
        Shell.Run(WScript.Path + "\\cscript.exe "
                  + Quote(WScript.ScriptFullName) + " //Nologo "
                  + FormatArguments(), 1, false);
        WScript.Quit(0);
    }
}

function IsArgsAvail() {
    var args = WScript.Arguments;
    var idx = 0;
    var check = true;

    while (idx < args.length) {
        var arg = args(idx);
        switch (arg) {
            case "-q":
                quietMode = true;
                break;
            case "-o":
                idx++;
                if (idx === args.length) {
                    check = false;
                } else {
                    outputFile = args(idx);
                }
                break;
            case "-w":
                // Sets the destination directory.  Handle this flag for
                // backward compatibility.
                idx++;
                if (idx === args.length) {
                    check = false;
                } else {
                    outputFolder = args(idx);
                }
                break;
            case "-u":
                collectOnlyUILogs = true;
                break;
            case "-s":
                collectStateLogs = true;
                break;
            case "-v":
                idx++;
                //check if next argument is provided
                if (idx === args.length) {
                    check = false;
                } else {
                    collectLogsForVMs = true;
                }
                break;
            case "--debug":
                debugScript = true;
                break;
            case "-h":
                check = false;
                break;
            default:
                check = false;
        }

        if (!check) {
            return false;
        }

        idx++;
    }
    return check;
}

function Usage() {
    WriteLine("Usage: vm-support.js [-q] [-o <output file>] [-s|-u|-v<path>] [-h]");
    WriteLine("  -q               Quiet mode. Do not print any unnecessary information");
    WriteLine("  -o               The filename (including path) to the resulting .zip file");
    WriteLine("  -u               Collect system information and UI logs");
    WriteLine("");
    WriteLine("  -v VMX filename(s) or dir path(s) separated by |");
    WriteLine("                   Collect logs only for the specified VMs");
    WriteLine("                   Example: vm-support.js -v \"path1\\file1 | path2\\file2\"");
    WriteLine("");
    WriteLine("  -s               Include state logs to vm-support package");
    WriteLine("");
    WriteLine("  -h               Display this help menu");
    WriteLine("");
    WriteLine(" If no options are given, collect logs for all VMs");
    WriteLine("");
    WriteLine("Press 'Enter' to close this window");

    WScript.StdIn.Read(1);
    WScript.Quit(0);
}

// Convert wscript version number if system uses comma as the decimal point.
var wversion = WScript.Version;
wversion = wversion.replace(/,/g, ".");

if (parseFloat(wversion) < 5.6) {
    WriteLine("This vm-support script expects Windows Script Version "
               + "5.6 or above");
    WScript.Quit(0);
}

EnsureCscript();

// Parse command line arguments

if (!IsArgsAvail()) {
    Usage();
} else {
    if (!quietMode) {
        WriteLine("VMware Support Script");
        WriteLine("Copyright (C) 1998-2026 Broadcom.");
        WriteLine("Warning: This script will collect most files in the Virtual Machines folder.");
        WriteLine("         Move any sensitive information to another folder.");
        WriteLine("");
    }

    var info = new VMsupport();
    info.Generate();
}
