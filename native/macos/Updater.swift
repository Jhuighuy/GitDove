// GitDove Updater: runs Sparkle on behalf of the GitDove app that launched it.
//
// Electron cannot host Sparkle in its own process, so `src/main/sparkle.ts` starts this helper
// with the path of the GitDove bundle and talks to it over JSON lines:
//
//   stdout  {"kind": "checking" | "idle" | "available" | "downloading" | "ready" | "error", ...}
//   stdin   "check"    check for updates now
//           "install"  install the downloaded update now: Sparkle quits and relaunches GitDove
//
// Sparkle checks on startup and on its schedule (`SUScheduledCheckInterval`), downloads updates
// silently, and installs a downloaded update when GitDove quits. GitDove closes stdin when it
// quits; the helper then exits and Sparkle's installer finishes on its own.

import AppKit
import Sparkle

struct Event: Encodable {
  let kind: String
  var version: String? = nil
  var percent: Double? = nil
  var message: String? = nil
}

func emit(_ event: Event) {
  var line = try! JSONEncoder().encode(event)
  line.append(UInt8(ascii: "\n"))
  FileHandle.standardOutput.write(line)
}

@MainActor
final class Updater: NSObject, SPUUpdaterDelegate, SPUUserDriver {
  private var sparkle: SPUUpdater!
  /// The version of the update being downloaded or installed.
  private var version: String?
  /// Installs the downloaded update and relaunches GitDove; set once the update is ready.
  private var installNow: (() -> Void)?
  private var expectedLength: UInt64 = 0
  private var receivedLength: UInt64 = 0
  private var percent = -1.0

  init(app: Bundle) throws {
    super.init()
    sparkle = SPUUpdater(hostBundle: app, applicationBundle: app, userDriver: self, delegate: self)
    try sparkle.start()
    check()
  }

  func run(_ command: String) {
    switch command {
    case "check": check()
    case "install": install()
    default: emit(Event(kind: "error", message: "Unknown updater command: \(command)"))
    }
  }

  private func check() {
    if installNow != nil {
      emitReady()
    } else if sparkle.sessionInProgress {
      // A check or download is underway and reports its own outcome; tell about a download now.
      if let version { emit(Event(kind: "available", version: version)) }
    } else {
      version = nil
      emit(Event(kind: "checking"))
      sparkle.checkForUpdatesInBackground()
    }
  }

  private func install() {
    installNow?()
  }

  private func ready(install: @escaping () -> Void) {
    installNow = install
    emitReady()
  }

  /// GitDove ignores a "ready" event without a version (and `updater.check()` would then wait
  /// forever), so fall back to a generic name if Sparkle never told which version this is.
  /// GitDove shows it as "GitDove <version> is ready".
  private func emitReady() {
    emit(Event(kind: "ready", version: version ?? "update"))
  }

  // MARK: - SPUUpdaterDelegate

  func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    version = item.displayVersionString
    emit(Event(kind: "available", version: version))
  }

  /// Called once a silently downloaded update is ready. Returning true holds the update until
  /// GitDove either asks to restart or quits, when Sparkle installs it without relaunching.
  func updater(
    _ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
    immediateInstallationBlock: @escaping () -> Void
  ) -> Bool {
    version = item.displayVersionString
    ready(install: immediateInstallationBlock)
    return true
  }

  /// The single place where checks end: either nothing new was found or something failed.
  func updater(
    _ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?
  ) {
    guard let error = error as NSError? else { return }
    if error.domain == SUSparkleErrorDomain && error.code == Int(SUError.noUpdateError.rawValue) {
      emit(Event(kind: "idle"))
    } else {
      emit(Event(kind: "error", message: error.localizedDescription))
    }
  }

  // MARK: - SPUUserDriver
  //
  // Sparkle falls back to its user driver when an update cannot be installed silently, e.g. when
  // installing needs an administrator password. GitDove's UI stands in for Sparkle's windows.

  func show(
    _ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void
  ) {
    reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
  }

  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {}

  func showUpdateFound(
    with item: SUAppcastItem, state: SPUUserUpdateState,
    reply: @escaping (SPUUserUpdateChoice) -> Void
  ) {
    version = item.displayVersionString
    if item.isInformationOnlyUpdate {
      reply(.dismiss)
    } else if state.stage == .notDownloaded {
      reply(.install)  // Download it; Sparkle comes back with showReady once it is extracted.
    } else {
      // Downloaded in an earlier session (.downloaded) or already staged (.installing): installing
      // now would quit and relaunch GitDove, so wait for Restart like any other ready update.
      ready { reply(.install) }
    }
  }

  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}

  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}

  // Errors and "no update" are reported once, from `didFinishUpdateCycleFor`.
  func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
    acknowledgement()
  }

  func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
    acknowledgement()
  }

  func showDownloadInitiated(cancellation: @escaping () -> Void) {
    expectedLength = 0
    receivedLength = 0
    percent = -1
  }

  func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
    expectedLength = expectedContentLength
  }

  func showDownloadDidReceiveData(ofLength length: UInt64) {
    receivedLength += length
    guard expectedLength > 0 else { return }
    let current = min(100, (100 * Double(receivedLength) / Double(expectedLength)).rounded(.down))
    if current == percent { return }
    percent = current
    emit(Event(kind: "downloading", percent: current))
  }

  func showDownloadDidStartExtractingUpdate() {}

  func showExtractionReceivedProgress(_ progress: Double) {}

  func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    ready { reply(.install) }
  }

  func showInstallingUpdate(
    withApplicationTerminated applicationTerminated: Bool,
    retryTerminatingApplication: @escaping () -> Void
  ) {}

  func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
    acknowledgement()
  }

  func dismissUpdateInstallation() {}
}

@main
@MainActor
enum Main {
  static func main() {
    guard CommandLine.arguments.count == 2, let app = Bundle(path: CommandLine.arguments[1]) else {
      FileHandle.standardError.write(Data("usage: GitDove Updater <GitDove.app>\n".utf8))
      exit(64)
    }
    NSApplication.shared.setActivationPolicy(.prohibited)
    let updater: Updater
    do {
      updater = try Updater(app: app)
    } catch {
      emit(Event(kind: "error", message: error.localizedDescription))
      exit(1)
    }
    // Not `readLine()`: it holds C's `stdin` lock while waiting, and Sparkle's XML parsing takes
    // that lock on the main thread.
    Task {
      do {
        for try await line in FileHandle.standardInput.bytes.lines { updater.run(line) }
      } catch {}
      // GitDove is quitting (or gone).
      exit(0)
    }
    NSApplication.shared.run()
  }
}
