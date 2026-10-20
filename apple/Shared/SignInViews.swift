import SwiftUI

/// Picking the Cellovision server: found on the Wi-Fi, or typed in.
struct ServerView: View {
    @Environment(AppState.self) private var state
    @State private var address = ""
    @State private var status = ""
    @State private var busy = false
    @State private var found: [FoundServer] = []

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "play.circle.fill").font(.system(size: 72)).foregroundStyle(.tint)
                Text("Cellovision").font(.largeTitle.bold())
                Text("Watch your movies, shows, music and photos from your Cellovision server. Find it on this Wi-Fi, or type its address.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
                TextField("192.168.1.20", text: $address)
                    .textContentType(.URL)
                    #if os(iOS)
                    .keyboardType(.URL).textInputAutocapitalization(.never).textFieldStyle(.roundedBorder)
                    #endif
                    .autocorrectionDisabled()
                    .onSubmit { Task { await connect(address) } }
                Button("Connect") { Task { await connect(address) } }.buttonStyle(.borderedProminent).disabled(busy)
                Button("Find servers on this Wi-Fi") { Task { await find() } }.disabled(busy)
                if !status.isEmpty { Text(status).foregroundStyle(.secondary).multilineTextAlignment(.center) }
                ForEach(found) { f in
                    Button { Task { await connect(f.url.absoluteString) } } label: {
                        VStack(alignment: .leading) { Text(f.name).bold(); Text(f.url.host ?? "").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            .padding(32)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
    }

    private func connect(_ text: String) async {
        var a = text.trimmingCharacters(in: .whitespaces)
        guard !a.isEmpty else { return }
        if !a.hasPrefix("http://") && !a.hasPrefix("https://") { a = "http://\(a)" }
        guard var c = URLComponents(string: a), c.host != nil else { status = "That doesn't look like an address."; return }
        if c.port == nil && c.scheme == "http" { c.port = 8420 }
        c.path = ""
        guard let url = c.url else { return }
        busy = true; status = "Connecting to \(url.host ?? "")…"
        defer { busy = false }
        if let h = await API.hello(url, timeout: 6) { state.hello = h; state.server = url; status = "" }
        else { status = "No Cellovision server answered at \(url.host ?? ""). Check it's running and on this Wi-Fi." }
    }

    private func find() async {
        busy = true; status = "Looking… (a few seconds)"; found = []
        defer { busy = false }
        found = await Finder.find()
        status = found.isEmpty ? "No server answered on this Wi-Fi." : "Pick yours:"
    }
}

/// Who's watching? Profiles, a password if theirs has one, or a Pair Code.
struct SignInView: View {
    @Environment(AppState.self) private var state
    @State private var picked: ProfileLite?
    @State private var password = ""
    @State private var error = ""
    @State private var pair: PairStart?

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Text("Who's watching?").font(.largeTitle.bold())
                Text(state.hello?.name ?? "").foregroundStyle(.secondary)
                if let p = picked {
                    VStack(spacing: 14) {
                        Text(p.name).font(.title2.bold())
                        SecureField("Password", text: $password).onSubmit { Task { await signIn(p.name, password) } }
                            #if os(iOS)
                            .textFieldStyle(.roundedBorder)
                            #endif
                        HStack { Button("Sign in") { Task { await signIn(p.name, password) } }.buttonStyle(.borderedProminent); Button("Back") { picked = nil; password = "" } }
                    }.frame(maxWidth: 420)
                } else if let pair {
                    VStack(spacing: 12) {
                        Text("On a phone or computer that's signed in, open Pair Code and type:")
                        Text(pair.code).font(.system(size: 54, weight: .heavy, design: .monospaced)).tracking(8)
                        Button("Cancel") { self.pair = nil }
                    }
                    .task(id: pair.code) { await waitForApproval(pair) }
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 24)], spacing: 24) {
                        ForEach(state.hello?.profiles ?? []) { p in
                            Button { if p.hasPassword { picked = p } else { Task { await signIn(p.name, "") } } } label: {
                                VStack {
                                    Text(String(p.name.prefix(1)).uppercased()).font(.system(size: 48, weight: .bold)).frame(width: 110, height: 110)
                                        .background(LinearGradient(colors: [Color(red: 0.55, green: 0.42, blue: 1), Color(red: 0.25, green: 0.72, blue: 1)], startPoint: .topLeading, endPoint: .bottomTrailing))
                                        .clipShape(RoundedRectangle(cornerRadius: 22)).foregroundStyle(.white)
                                    Text(p.name).bold()
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    HStack(spacing: 16) {
                        Button("Use a Pair Code") { Task { await startPair() } }
                        Button("Change server") { state.forgetServer() }
                    }
                }
                if !error.isEmpty { Text(error).foregroundStyle(.red) }
            }
            .padding(40)
        }
        .task { if state.hello == nil, let s = state.server { state.hello = await API.hello(s, timeout: 6) } }
    }

    private func signIn(_ name: String, _ password: String) async {
        error = ""
        do {
            let t: Token = try await state.api.send("POST", "/api/signin", ["name": name, "password": password, "device": AppState.deviceName, "client": "apple"])
            await state.signedIn(with: t.token)
        } catch { self.error = error.localizedDescription }
    }

    private func startPair() async {
        do { pair = try await state.api.send("POST", "/api/pair/start", ["device": AppState.deviceName, "client": "apple"]) } catch { self.error = error.localizedDescription }
    }

    private func waitForApproval(_ p: PairStart) async {
        while !Task.isCancelled && pair?.code == p.code {
            try? await Task.sleep(for: .seconds(2))
            guard let r: PairCheck = try? await state.api.send("POST", "/api/pair/check", ["code": p.code, "secret": p.secret]) else { pair = nil; error = "That code ran out. Try again."; return }
            if r.approved, let t = r.token { pair = nil; await state.signedIn(with: t); return }
        }
    }
}

/// Settings: Pair Code (sign in a TV from here), sign out, change server.
struct SettingsView: View {
    @Environment(AppState.self) private var state
    @State private var code = ""
    @State private var message = ""

    var body: some View {
        Form {
            Section {
                Text(state.me?.name ?? "").bold()
                Text(state.hello?.name ?? state.server?.host ?? "").foregroundStyle(.secondary)
            }
            #if os(iOS)
            Section("Pair Code") {
                Text("Signing in a TV? Choose “Use a Pair Code” on it, then type the code it shows.").font(.footnote).foregroundStyle(.secondary)
                TextField("ABC123", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().font(.title3.monospaced())
                Button("Sign it in") { Task { await approve() } }.disabled(code.count < 6)
                if !message.isEmpty { Text(message).font(.footnote) }
            }
            CindySettingsSection()
            #endif
            Section {
                Button("Switch profile / sign out") { Task { await state.signOut() } }
                Button("Change server", role: .destructive) { state.forgetServer() }
            }
            Section { Text("Cellovision for \(AppState.deviceName) \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")").font(.footnote).foregroundStyle(.secondary) }
        }
        .navigationTitle("Settings")
    }

    private func approve() async {
        do { let r: PairApproved = try await state.api.send("POST", "/api/pair/approve", ["code": code]); message = "\(r.device ?? "It") is signed in as you."; code = "" }
        catch { message = error.localizedDescription }
    }
}
