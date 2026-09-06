# Zhiqu Windows Backup

This backup setup is for a small Windows Server with only a system disk.

It backs up:

- MySQL database `zhiqu_db`
- uploaded files in `C:\zhiqu\uploads`
- production config `C:\zhiqu\application-prod.yml`

It creates a local zip under `C:\zhiqu\backup`, uploads it through `rclone`, keeps local backups for 3 days, and keeps remote backups for 30 days.

## 1. Copy scripts

On the server, create:

```powershell
New-Item -ItemType Directory -Force C:\zhiqu\scripts
```

Copy these files to `C:\zhiqu\scripts`:

- `backup-zhiqu.ps1`
- `install-zhiqu-backup-task.ps1`

## 2. Install and configure rclone

Put rclone at:

```text
C:\rclone\rclone.exe
```

Then configure your remote:

```powershell
C:\rclone\rclone.exe config
```

Create a remote named:

```text
zhiqu-backup
```

Test:

```powershell
C:\rclone\rclone.exe lsd zhiqu-backup:
```

The default script uploads to:

```text
zhiqu-backup:zhiqu-backup
```

## 3. Set database password safely

Do not write the MySQL password into the script.

Set it as a machine environment variable:

```powershell
[Environment]::SetEnvironmentVariable("ZHIQU_DB_PASSWORD", "your_mysql_password", "Machine")
```

Open a new PowerShell window after setting it.

## 4. Test backup once

```powershell
powershell.exe -ExecutionPolicy Bypass -File C:\zhiqu\scripts\backup-zhiqu.ps1
```

Check:

```text
C:\zhiqu\backup
C:\zhiqu\logs\backup-zhiqu.log
C:\zhiqu\logs\rclone-backup.log
```

Also check that the zip appears in your remote storage.

## 5. Install daily scheduled task

Run PowerShell as Administrator:

```powershell
powershell.exe -ExecutionPolicy Bypass -File C:\zhiqu\scripts\install-zhiqu-backup-task.ps1
```

Default schedule:

```text
Daily at 02:30
```

## 6. Restore basics

Unzip a backup package. Restore MySQL:

```powershell
mysql -u root -p zhiqu_db < zhiqu_db.sql
```

Restore uploaded files by copying the `uploads` folder back to:

```text
C:\zhiqu\uploads
```

Important: local backups on the same 50G disk are only temporary. The remote rclone copy is the real disaster backup.
