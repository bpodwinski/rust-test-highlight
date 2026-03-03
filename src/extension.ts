import { default as init, parseFile } from "astexplorer-syn";
import synWasmUrl from "astexplorer-syn/astexplorer_syn_bg.wasm?url";
import { default as dlv } from "dlv";
import * as vscode from "vscode";
import { walkAst } from "./ast";

const TEST_SCOPE_SEMANTIC_TOKEN = "rustTestHighlight.testScope";
const SEMANTIC_TOKENS_SETTING_KEY = "rustTestHighlight.semanticTokens.enabled";

export function activate(context: vscode.ExtensionContext) {
	const isDev = context.extensionMode === vscode.ExtensionMode.Development;
	let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
	let testDecoration: vscode.TextEditorDecorationType | undefined = undefined;
	const semanticTokensLegend = new vscode.SemanticTokensLegend([TEST_SCOPE_SEMANTIC_TOKEN], []);
	const semanticTokensChangedEmitter = new vscode.EventEmitter<void>();

	const synReady = fetch(synWasmUrl)
		.then((response) => init(response))
		.catch((e) => {
			console.error(e);
			vscode.window.showErrorMessage(
				`Failed to load Rust language parser. Check extension host logs for details.`
			);
		});

	let activeEditor = vscode.window.activeTextEditor;

	if (import.meta.env.MODE === "development") {
		writeSampleToEditor(activeEditor);
	}

	async function updateDecorations() {
		if (!activeEditor) {
			return;
		}

		if (!(await synReady)) {
			return;
		}

		const text = activeEditor.document.getText();
		let testRanges: vscode.Range[] = [];

		try {
			testRanges = getTestModuleRanges(text);
		} catch (error) {
			// TODO: allow a user to opt in to seeing errors?
			if (isDev) {
				console.error(error);
			}

			// we failed to parse or walk the AST, so just bail and
			// don't do anything with the decorations that exist
			return;
		}

		const testBlocks: vscode.DecorationOptions[] = testRanges.map((range) => ({ range }));

		if (testBlocks.length > 0) {
			// we have tests to highlight, create the decoration if one does not yet exist
			testDecoration ??= vscode.window.createTextEditorDecorationType({
				// use a themable color. See package.json for the declaration and default values.
				backgroundColor: { id: "rustTestHighlight.backgroundColor" },
				// VS Code does not expose minimap-specific decoration colors; use the overview ruler.
				overviewRulerColor: new vscode.ThemeColor("rustTestHighlight.backgroundColor"),
				overviewRulerLane: vscode.OverviewRulerLane.Full,
				// IDEA: should this be user configurable?
				isWholeLine: true,
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			});

			activeEditor.setDecorations(testDecoration, testBlocks);
		} else {
			// we do not have tests to highlight, so get rid of the decorations if they still exist
			testDecoration?.dispose();
			testDecoration = undefined;
		}
	}

	const semanticTokensProvider: vscode.DocumentSemanticTokensProvider = {
		onDidChangeSemanticTokens: semanticTokensChangedEmitter.event,
		async provideDocumentSemanticTokens(document, token) {
			const builder = new vscode.SemanticTokensBuilder(semanticTokensLegend);

			if (!isSemanticTokensEnabled()) {
				return builder.build();
			}

			if (token.isCancellationRequested) {
				return builder.build();
			}

			if (!(await synReady) || token.isCancellationRequested) {
				return builder.build();
			}

			try {
				const testRanges = getTestModuleRanges(document.getText());

				for (const range of testRanges) {
					pushRangeSemanticTokensByLine(builder, document, range);
				}
			} catch (error) {
				if (isDev) {
					console.error(error);
				}
			}

			return builder.build();
		},
	};

	function triggerUpdateDecorations(throttle = false) {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		if (throttle) {
			timeout = setTimeout(updateDecorations, 500);
		} else {
			updateDecorations();
		}
	}

	if (activeEditor) {
		triggerUpdateDecorations();
	}

	context.subscriptions.push(
		semanticTokensChangedEmitter,
		vscode.languages.registerDocumentSemanticTokensProvider(
			{ language: "rust" },
			semanticTokensProvider,
			semanticTokensLegend
		)
	);

	vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			activeEditor = editor;
			if (editor) {
				triggerUpdateDecorations();
			}
		},
		null,
		context.subscriptions
	);

	vscode.workspace.onDidChangeTextDocument(
		(event) => {
			if (activeEditor && event.document === activeEditor.document) {
				triggerUpdateDecorations(true);
			}

			if (event.document.languageId === "rust") {
				semanticTokensChangedEmitter.fire();
			}
		},
		null,
		context.subscriptions
	);

	vscode.workspace.onDidChangeConfiguration(
		(event) => {
			if (event.affectsConfiguration(SEMANTIC_TOKENS_SETTING_KEY)) {
				semanticTokensChangedEmitter.fire();
			}
		},
		null,
		context.subscriptions
	);
}

export function deactivate() {}

function clamp(num: number, min?: number, max?: number) {
	if (min !== undefined && num < min) {
		return min;
	}

	if (max !== undefined && num > max) {
		return max;
	}

	return num;
}

function getTestModuleRanges(text: string) {
	const ast = parseFile(text);
	const testRanges: vscode.Range[] = [];

	walkAst(ast, (node, _parent): false | void => {
		if (dlv(node, "_type") === "ItemMod") {
			// IDEA: should the name of the test module be configurable by a user?
			if (dlv(node, "ident.to_string") === "tests") {
				const startLine = dlv(node, "span.start.line");
				const startCol = dlv(node, "span.start.column");
				const endLine = dlv(node, "span.end.line");
				const endCol = dlv(node, "span.end.column");

				const hasRangeInfo =
					typeof startLine === "number" &&
					typeof startCol === "number" &&
					typeof endLine === "number" &&
					typeof endCol === "number";

				if (!hasRangeInfo) {
					return false;
				}

				const startPos = new vscode.Position(clamp(startLine - 1, 0), clamp(startCol - 1, 0));
				const endPos = new vscode.Position(clamp(endLine - 1, 0), clamp(endCol, 0));

				testRanges.push(new vscode.Range(startPos, endPos));
			}
		}
	});

	return testRanges;
}

function isSemanticTokensEnabled() {
	return vscode.workspace
		.getConfiguration("rustTestHighlight")
		.get<boolean>("semanticTokens.enabled", true);
}

function pushRangeSemanticTokensByLine(
	builder: vscode.SemanticTokensBuilder,
	document: vscode.TextDocument,
	range: vscode.Range
) {
	if (document.lineCount < 1) {
		return;
	}

	const startLine = clamp(range.start.line, 0, document.lineCount - 1);
	const endLine = clamp(range.end.line, 0, document.lineCount - 1);

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
		const lineText = document.lineAt(lineNumber).text;
		const lineLength = lineText.length;
		const startChar = lineNumber === startLine ? clamp(range.start.character, 0, lineLength) : 0;
		const endChar = lineNumber === endLine ? clamp(range.end.character, 0, lineLength) : lineLength;
		const tokenLength = endChar - startChar;

		if (tokenLength > 0) {
			builder.push(lineNumber, startChar, tokenLength, TEST_SCOPE_SEMANTIC_TOKEN, []);
		}
	}
}

function writeSampleToEditor(editor?: vscode.TextEditor) {
	setTimeout(() => {
		editor?.edit((b) => {
			b.insert(
				new vscode.Position(0, 0),
				`
	
					
// cool comment but not part of the module

mod nested {
	pub fn add() {}

	mod nested_again {
		/*
		
		some comments



		*/

		#[cfg(test)]
		mod not_tests {
				#[test]
				fn test() {
	
				}
		}

		/// nested docs
		/// wooooo
		#[cfg(test)]
		mod tests {
				#[test]
				fn test() {
	
				}
		}
	}

	#[cfg(test)]
	mod tests {
			#[test]
			fn test() {

			}
	}
}

/// some docs
///
///
/// wooo
#[cfg(test)]
mod tests {
		#[test]
		fn test() {
				
		}
}							
			`
			);
		});
	}, 500);
}
