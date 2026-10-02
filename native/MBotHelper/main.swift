import AppKit
import ApplicationServices
import Foundation

private let museBundleIdentifier = "com.meta.endo"

struct AppInfo: Encodable {
    let bundleIdentifier: String
    let name: String
    let pid: Int32
}

struct AccessibilityNode: Encodable {
    let path: String
    let role: String?
    let subrole: String?
    let identifier: String?
    let title: String?
    let description: String?
    let value: String?
    let enabled: Bool?
    let focused: Bool?
    let children: [AccessibilityNode]
}

struct HelperError: Encodable {
    let code: String
    let message: String
}

struct HelperOutput: Encodable {
    let ok: Bool
    let command: String
    let trusted: Bool
    let app: AppInfo?
    let snapshot: AccessibilityNode?
    let nodeCount: Int?
    let truncated: Bool?
    let error: HelperError?
}

final class SnapshotBudget {
    let maxDepth: Int
    let maxNodes: Int
    private(set) var nodeCount = 0
    private(set) var truncated = false

    init(maxDepth: Int, maxNodes: Int) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
    }

    func claim(depth: Int) -> Bool {
        guard depth <= maxDepth, nodeCount < maxNodes else {
            truncated = true
            return false
        }
        nodeCount += 1
        return true
    }
}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else {
        return nil
    }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let string = value as? String {
        return string
    }
    if let number = value as? NSNumber {
        return number.stringValue
    }
    return nil
}

func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool? {
    (attribute(element, name) as? NSNumber)?.boolValue
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func snapshotRoot(_ application: AXUIElement) -> AXUIElement {
    if let focusedWindow = attribute(application, kAXFocusedWindowAttribute as CFString) {
        return focusedWindow as! AXUIElement
    }
    if let windows = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement],
       let firstWindow = windows.first {
        return firstWindow
    }
    return application
}

func findElement(_ element: AXUIElement, label: String) -> AXUIElement? {
    let title = stringAttribute(element, kAXTitleAttribute as CFString)
    let description = stringAttribute(element, kAXDescriptionAttribute as CFString)
    if title == label || description == label {
        return element
    }
    for child in childElements(element) {
        if let match = findElement(child, label: label) {
            return match
        }
    }
    return nil
}

func findComposer(_ element: AXUIElement, depth: Int = 0) -> AXUIElement? {
    guard depth <= 30 else { return nil }
    let role = stringAttribute(element, kAXRoleAttribute as CFString)
    let title = stringAttribute(element, kAXTitleAttribute as CFString) ?? ""
    if role == (kAXButtonRole as String), title.contains("Message"), title.contains("Send") {
        return element
    }
    for child in childElements(element) {
        if let match = findComposer(child, depth: depth + 1) {
            return match
        }
    }
    return nil
}

func postText(_ text: String, to processIdentifier: pid_t) -> Bool {
    let characters = Array(text.utf16)
    for start in stride(from: 0, to: characters.count, by: 32) {
        var chunk = Array(characters[start..<min(start + 32, characters.count)])
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            return false
        }
        down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        down.postToPid(processIdentifier)
        up.postToPid(processIdentifier)
    }
    return true
}

func postKey(_ virtualKey: CGKeyCode, flags: CGEventFlags = [], to processIdentifier: pid_t) -> Bool {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false) else {
        return false
    }
    down.flags = flags
    up.flags = flags
    down.postToPid(processIdentifier)
    up.postToPid(processIdentifier)
    return true
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let positionValue = attribute(element, kAXPositionAttribute as CFString),
          let sizeValue = attribute(element, kAXSizeAttribute as CFString) else {
        return nil
    }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
        return nil
    }
    return CGRect(origin: position, size: size)
}

func clickCenter(_ element: AXUIElement, application: NSRunningApplication) -> Bool {
    guard let bounds = frame(element) else { return false }
    return click(CGPoint(x: bounds.midX, y: bounds.midY), application: application)
}

func click(_ point: CGPoint, application: NSRunningApplication) -> Bool {
    application.activate()
    Thread.sleep(forTimeInterval: 0.1)
    guard let down = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDown,
        mouseCursorPosition: point,
        mouseButton: .left
    ), let up = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else {
        return false
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return true
}

func clipped(_ value: String?, limit: Int = 4_096) -> String? {
    guard let value else { return nil }
    if value.count <= limit { return value }
    return String(value.prefix(limit)) + "…"
}

func readableValue(_ element: AXUIElement, role: String?) -> String? {
    guard role != "AXSecureTextField" else { return nil }
    let readableRoles = Set([
        kAXStaticTextRole as String,
        kAXTextAreaRole as String,
        kAXTextFieldRole as String,
        kAXButtonRole as String,
        "AXLink",
        kAXHeadingRole as String,
    ])
    guard let role, readableRoles.contains(role) else { return nil }
    return clipped(stringAttribute(element, kAXValueAttribute as CFString))
}

func snapshot(_ element: AXUIElement, path: String, depth: Int, budget: SnapshotBudget) -> AccessibilityNode? {
    guard budget.claim(depth: depth) else { return nil }
    let role = stringAttribute(element, kAXRoleAttribute as CFString)
    let children = childElements(element).enumerated().compactMap { index, child in
        snapshot(child, path: "\(path)/\(index)", depth: depth + 1, budget: budget)
    }
    return AccessibilityNode(
        path: path,
        role: role,
        subrole: stringAttribute(element, kAXSubroleAttribute as CFString),
        identifier: clipped(stringAttribute(element, kAXIdentifierAttribute as CFString), limit: 512),
        title: clipped(stringAttribute(element, kAXTitleAttribute as CFString)),
        description: clipped(stringAttribute(element, kAXDescriptionAttribute as CFString)),
        value: readableValue(element, role: role),
        enabled: boolAttribute(element, kAXEnabledAttribute as CFString),
        focused: boolAttribute(element, kAXFocusedAttribute as CFString),
        children: children
    )
}

func museApplication() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == museBundleIdentifier }
}

func encode(_ output: HelperOutput) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(output) else {
        FileHandle.standardError.write(Data("Unable to encode helper output.\n".utf8))
        exit(1)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? "status"
let prompt = command == "request-permission"
let trusted: Bool
if prompt {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    trusted = AXIsProcessTrustedWithOptions(options)
} else {
    trusted = AXIsProcessTrusted()
}

let runningApp = museApplication()
let appInfo = runningApp.map {
    AppInfo(
        bundleIdentifier: $0.bundleIdentifier ?? museBundleIdentifier,
        name: $0.localizedName ?? "Muse",
        pid: $0.processIdentifier
    )
}

switch command {
case "status", "request-permission":
    encode(HelperOutput(
        ok: true,
        command: command,
        trusted: trusted,
        app: appInfo,
        snapshot: nil,
        nodeCount: nil,
        truncated: nil,
        error: nil
    ))
case "snapshot":
    guard trusted else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: false,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "accessibility_permission_required", message: "Grant Accessibility access to mbot-helper in System Settings.")
        ))
        exit(3)
    }
    guard let runningApp else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: nil,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "muse_not_running", message: "Muse is not running.")
        ))
        exit(4)
    }
    let maxDepth = Int(arguments.dropFirst().first ?? "14") ?? 14
    let maxNodes = Int(arguments.dropFirst(2).first ?? "3000") ?? 3000
    let budget = SnapshotBudget(maxDepth: min(max(maxDepth, 1), 30), maxNodes: min(max(maxNodes, 1), 10_000))
    let application = AXUIElementCreateApplication(runningApp.processIdentifier)
    let root = snapshotRoot(application)
    let tree = snapshot(root, path: "0", depth: 0, budget: budget)
    encode(HelperOutput(
        ok: tree != nil,
        command: command,
        trusted: true,
        app: appInfo,
        snapshot: tree,
        nodeCount: budget.nodeCount,
        truncated: budget.truncated,
        error: tree == nil ? HelperError(code: "snapshot_unavailable", message: "Muse accessibility tree is unavailable.") : nil
    ))
case "press", "focus", "click":
    guard trusted else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: false,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "accessibility_permission_required", message: "Grant Accessibility access to mbot-helper in System Settings.")
        ))
        exit(3)
    }
    guard let runningApp else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: nil,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "muse_not_running", message: "Muse is not running.")
        ))
        exit(4)
    }
    guard let label = arguments.dropFirst().first, !label.isEmpty else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "missing_label", message: "The press command requires an exact control label.")
        ))
        exit(2)
    }
    let application = AXUIElementCreateApplication(runningApp.processIdentifier)
    guard let element = findElement(snapshotRoot(application), label: label) else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "control_not_found", message: "Muse control was not found: \(label)")
        ))
        exit(5)
    }
    let actionSucceeded: Bool
    if command == "press" {
        actionSucceeded = AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    } else if command == "focus" {
        actionSucceeded = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    } else {
        actionSucceeded = clickCenter(element, application: runningApp)
    }
    if actionSucceeded {
        Thread.sleep(forTimeInterval: 0.15)
    }
    encode(HelperOutput(
        ok: actionSucceeded,
        command: command,
        trusted: true,
        app: appInfo,
        snapshot: nil,
        nodeCount: nil,
        truncated: nil,
        error: actionSucceeded ? nil : HelperError(code: "control_unavailable", message: "Muse control action failed: \(command) \(label)")
    ))
    if !actionSucceeded {
        exit(5)
    }
case "type":
    guard trusted else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: false,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "accessibility_permission_required", message: "Grant Accessibility access to mbot-helper in System Settings.")
        ))
        exit(3)
    }
    guard let runningApp else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: nil,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "muse_not_running", message: "Muse is not running.")
        ))
        exit(4)
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let message = String(data: input, encoding: .utf8), !message.isEmpty else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "missing_input", message: "The type command requires UTF-8 text on stdin.")
        ))
        exit(2)
    }
    let posted = postText(message, to: runningApp.processIdentifier)
    if posted {
        Thread.sleep(forTimeInterval: 0.2)
    }
    encode(HelperOutput(
        ok: posted,
        command: command,
        trusted: true,
        app: appInfo,
        snapshot: nil,
        nodeCount: nil,
        truncated: nil,
        error: posted ? nil : HelperError(code: "text_entry_failed", message: "Text could not be sent to Muse.")
    ))
    if !posted {
        exit(5)
    }
case "set-value":
    guard trusted else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: false,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "accessibility_permission_required", message: "Grant Accessibility access to mbot-helper in System Settings.")
        ))
        exit(3)
    }
    guard let runningApp else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: nil,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "muse_not_running", message: "Muse is not running.")
        ))
        exit(4)
    }
    guard let label = arguments.dropFirst().first, !label.isEmpty else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "missing_label", message: "The set-value command requires an exact control label.")
        ))
        exit(2)
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let value = String(data: input, encoding: .utf8), !value.isEmpty else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "missing_input", message: "The set-value command requires UTF-8 text on stdin.")
        ))
        exit(2)
    }
    let application = AXUIElementCreateApplication(runningApp.processIdentifier)
    guard let element = findElement(snapshotRoot(application), label: label) else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "control_not_found", message: "Muse control was not found: \(label)")
        ))
        exit(5)
    }
    let valueError = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
    if valueError == .success {
        Thread.sleep(forTimeInterval: 0.2)
    }
    encode(HelperOutput(
        ok: valueError == .success,
        command: command,
        trusted: true,
        app: appInfo,
        snapshot: nil,
        nodeCount: nil,
        truncated: nil,
        error: valueError == .success ? nil : HelperError(code: "value_assignment_failed", message: "Muse composer does not accept direct AXValue assignment (AXError \(valueError.rawValue)).")
    ))
    if valueError != .success {
        exit(5)
    }
case "submit":
    guard trusted else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: false,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "accessibility_permission_required", message: "Grant Accessibility access to mbot-helper in System Settings.")
        ))
        exit(3)
    }
    guard let runningApp else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: nil,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "muse_not_running", message: "Muse is not running.")
        ))
        exit(4)
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let message = String(data: input, encoding: .utf8), !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "missing_input", message: "The submit command requires UTF-8 text on stdin.")
        ))
        exit(2)
    }
    let application = AXUIElementCreateApplication(runningApp.processIdentifier)
    guard let composer = findComposer(snapshotRoot(application)) else {
        encode(HelperOutput(
            ok: false,
            command: command,
            trusted: true,
            app: appInfo,
            snapshot: nil,
            nodeCount: nil,
            truncated: nil,
            error: HelperError(code: "composer_not_found", message: "Muse composer was not found in the focused window.")
        ))
        exit(5)
    }
    let editorPoint = frame(composer).map { bounds in
        CGPoint(x: bounds.midX, y: bounds.midY)
    }
    let clearedValue = AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, "" as CFString) == .success
    let focused = clearedValue && editorPoint.map { click($0, application: runningApp) } == true
    if focused {
        Thread.sleep(forTimeInterval: 0.1)
    }
    let cleared = focused &&
        postKey(0, flags: .maskCommand, to: runningApp.processIdentifier) &&
        postKey(51, to: runningApp.processIdentifier)
    let typed = cleared && postText(message, to: runningApp.processIdentifier)
    if typed {
        Thread.sleep(forTimeInterval: 0.1)
    }
    let submitted = typed && postKey(36, to: runningApp.processIdentifier)
    if submitted {
        Thread.sleep(forTimeInterval: 0.3)
    }
    encode(HelperOutput(
        ok: submitted,
        command: command,
        trusted: true,
        app: appInfo,
        snapshot: nil,
        nodeCount: nil,
        truncated: nil,
        error: submitted ? nil : HelperError(code: "message_submission_failed", message: "Muse did not accept the composer value and Return action.")
    ))
    if !submitted {
        exit(5)
    }
default:
    encode(HelperOutput(
        ok: false,
        command: command,
        trusted: trusted,
        app: appInfo,
        snapshot: nil,
        nodeCount: nil,
        truncated: nil,
        error: HelperError(code: "unknown_command", message: "Unknown helper command: \(command)")
    ))
    exit(2)
}