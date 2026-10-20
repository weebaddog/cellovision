import SwiftUI

@main
struct CellovisionApp: App {
    @State private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(state)
                .preferredColorScheme(.dark)
                .tint(Color(red: 0.55, green: 0.42, blue: 1.0))
        }
    }
}

/// Server picker → profile sign-in → the app.
struct RootView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        Group {
            if state.server == nil { ServerView() }
            else if state.token == nil { SignInView() }
            else { MainView() }
        }
        .task(id: state.token) { await state.loadMe() }
    }
}

struct MainView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        @Bindable var state = state
        TabView {
            NavigationStack { HomeView() }.tabItem { Label("Home", systemImage: "house") }
            NavigationStack { SearchView() }.tabItem { Label("Search", systemImage: "magnifyingglass") }
            NavigationStack { HeartsView() }.tabItem { Label("Hearts", systemImage: "heart") }
            NavigationStack { SettingsView() }.tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .fullScreenCover(item: $state.playing) { PlayerScreen(request: $0) }
    }
}
