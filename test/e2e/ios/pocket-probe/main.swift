import UIKit
import WebKit

// Built and driven by ../top-scroll-pocket.test.ts.
//
// Hosts a page full screen under the status bar, the way an installed web app
// does, runs `label=script` JS steps from the launch arguments, and after each
// step prints whether WebKit is showing a top color extension view (which
// hides the iOS 26+ top scroll pocket blur). Safari cannot show the blur at
// all, because its own toolbar covers that area, so this needs a WKWebView host.
final class ProbeViewController: UIViewController, WKNavigationDelegate {
	let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
	var steps: [String] = []
	var started = false

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .black
		webView.frame = view.bounds
		webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
		webView.navigationDelegate = self
		if #available(iOS 16.4, *) { webView.isInspectable = true }
		view.addSubview(webView)
		let args = ProcessInfo.processInfo.arguments
		steps = Array(args.dropFirst(2))
		webView.load(URLRequest(url: URL(string: args[1])!))
	}

	// An installed web app reports the status bar as an obscured inset; a plain
	// WKWebView host does not, and WebKit only adds color extension views
	// (and hides the pocket) where that inset is > 0.
	override func viewSafeAreaInsetsDidChange() {
		super.viewSafeAreaInsetsDidChange()
		let sel = NSSelectorFromString("_setObscuredInsets:")
		guard webView.responds(to: sel) else { print("PROBE no _setObscuredInsets"); return }
		typealias Setter = @convention(c) (AnyObject, Selector, UIEdgeInsets) -> Void
		let top = view.safeAreaInsets.top
		unsafeBitCast(webView.method(for: sel), to: Setter.self)(webView, sel, UIEdgeInsets(top: top, left: 0, bottom: 0, right: 0))
		// Start the page below the status bar, as the installed app does
		// (the original fix saw the blur over the session bar's first row).
		webView.scrollView.contentInsetAdjustmentBehavior = .never
		webView.scrollView.contentInset = UIEdgeInsets(top: top, left: 0, bottom: 0, right: 0)
		webView.scrollView.contentOffset = CGPoint(x: 0, y: -top)
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		guard !started else { return }
		started = true
		run(0)
	}

	func extensionViews(in root: UIView) -> [UIView] {
		root.subviews.flatMap { sub -> [UIView] in
			(NSStringFromClass(type(of: sub)).contains("ColorExtension") ? [sub] : []) + extensionViews(in: sub)
		}
	}

	func nativeState() -> String {
		let top = extensionViews(in: webView).filter { $0.frame.minY <= 0 && $0.frame.width > 100 }
		let visible = top.filter { !$0.isHidden && $0.alpha > 0.01 && $0.frame.height > 0 }
		let detail = top.map { "\(Int($0.frame.minY)),\(Int($0.frame.height)) h=\($0.isHidden) a=\(String(format: "%.2f", $0.alpha))" }.joined(separator: "; ")
		var edge = "?"
		if #available(iOS 26.0, *) { edge = webView.scrollView.topEdgeEffect.isHidden ? "hidden" : "shown" }
		return "pocketHidden=\(!visible.isEmpty) topEdgeEffect=\(edge) safeTop=\(Int(view.safeAreaInsets.top)) views=[\(detail)]"
	}

	func run(_ index: Int) {
		guard index < steps.count else {
			print("PROBE done"); fflush(stdout)
			DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
			return
		}
		let parts = steps[index].split(separator: "=", maxSplits: 1).map(String.init)
		let label = parts[0], script = parts.count > 1 ? parts[1] : ""
		DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
			// An async function body, so a step can await (e.g. poll until ready).
			self.webView.callAsyncJavaScript(script, in: nil, in: .page) { result in
				let js: String
				switch result {
				case .success(let value): js = "js=\(value)"
				case .failure(let error):
					js = "jsError=\((error as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? error.localizedDescription)"
				}
				// Timeline: one letter per 100ms for 2s. H = pocket hidden, S = blur shown.
				var timeline = ""
				func sample(_ n: Int) {
					timeline += self.nativeState().hasPrefix("pocketHidden=true") ? "H" : "S"
					if n < 20 {
						DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { sample(n + 1) }
						return
					}
					print("PROBE \(label) \(timeline) \(self.nativeState()) \(js)"); fflush(stdout)
					self.run(index + 1)
				}
				sample(0)
			}
		}
	}
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
	func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
		let config = UISceneConfiguration(name: nil, sessionRole: session.role)
		config.delegateClass = SceneDelegate.self
		return config
	}
}

// iOS 27 refuses to launch apps without the UIScene lifecycle.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
	var window: UIWindow?
	func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
		guard let windowScene = scene as? UIWindowScene else { return }
		window = UIWindow(windowScene: windowScene)
		window?.rootViewController = ProbeViewController()
		window?.makeKeyAndVisible()
	}
}
