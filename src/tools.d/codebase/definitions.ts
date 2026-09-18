/**
 * @fileoverview Language configuration definitions for Tree-sitter based code parsing.
 * Provides mappings from Tree-sitter node types to outline categories for various programming languages.
 * @module definitions
 */

/**
 * Configuration interface for a programming language's Tree-sitter parser.
 * @interface LanguageConfig
 */
export interface LanguageConfig {
    /** 
     * The name of the WebAssembly file for this language's Tree-sitter parser.
     * @example 'tree-sitter-typescript.wasm'
     */
    wasmName: string;

    /**
     * Mapping from Tree-sitter node types to outline category names.
     * Keys are node types (e.g., 'class_declaration'), values are category names (e.g., 'Class').
     */
    definitions: Record<string, string>;

    /**
     * The field name used to extract the identifier/name from a node.
     * If not specified, the parser will attempt to find the first child identifier.
     * @example 'name'
     */
    nameField?: string;

    /**
     * Set of node types that can contain other definitions (e.g., classes, namespaces).
     * These nodes will be recursively scanned for child members.
     */
    containers: Set<string>;
}

/**
 * Language configurations for all supported programming languages.
 * Maps language IDs to their Tree-sitter parser configurations.
 * @type {Record<string, LanguageConfig>}
 */
export const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
    /** JavaScript/TypeScript family */
    'typescript': {
        wasmName: 'tree-sitter-typescript.wasm',
        definitions: {
            'class_declaration': 'Class',
            'interface_declaration': 'Interface',
            'function_declaration': 'Function',
            'method_definition': 'Method',
            'public_field_definition': 'Field',
            'type_alias_declaration': 'Type',
            'enum_declaration': 'Enum',
            'module': 'Module',
            'lexical_declaration': 'Variable',
            'variable_declaration': 'Variable'
        },
        containers: new Set([
            'class_declaration', 'interface_declaration', 'module', 'program', 'class_body', 'interface_body', 'export_statement'
        ])
    },
    'tsx': {
        wasmName: 'tree-sitter-tsx.wasm',
        definitions: {
            'class_declaration': 'Class',
            'interface_declaration': 'Interface',
            'function_declaration': 'Function',
            'method_definition': 'Method',
            'public_field_definition': 'Field',
            'type_alias_declaration': 'Type',
            'enum_declaration': 'Enum',
            'module': 'Module',
            'lexical_declaration': 'Variable',
            'variable_declaration': 'Variable'
        },
        containers: new Set([
            'class_declaration', 'interface_declaration', 'module', 'program', 'class_body', 'interface_body', 'export_statement'
        ])
    },
    'javascript': {
        wasmName: 'tree-sitter-javascript.wasm',
        definitions: {
            'class_declaration': 'Class',
            'function_declaration': 'Function',
            'method_definition': 'Method',
            'lexical_declaration': 'Variable',
            'variable_declaration': 'Variable'
        },
        containers: new Set([
            'class_declaration', 'program', 'class_body', 'export_statement'
        ])
    },
    'vue': {
        wasmName: 'tree-sitter-vue.wasm',
        definitions: {
            'script_element': 'Script',
            'template_element': 'Template',
            'style_element': 'Style'
        },
        containers: new Set(['component', 'program'])
    },

    /** C/C++ family */
    'c': {
        wasmName: 'tree-sitter-c.wasm',
        definitions: {
            'function_definition': 'Function',
            'struct_specifier': 'Struct',
            'enum_specifier': 'Enum',
            'type_definition': 'Type'
        },
        containers: new Set(['translation_unit', 'struct_specifier', 'compound_statement'])
    },
    'cpp': {
        wasmName: 'tree-sitter-cpp.wasm',
        definitions: {
            'function_definition': 'Function',
            'class_specifier': 'Class',
            'struct_specifier': 'Struct',
            'namespace_definition': 'Namespace',
            'template_declaration': 'Template',
            'using_declaration': 'Using'
        },
        containers: new Set(['translation_unit', 'class_specifier', 'struct_specifier', 'namespace_definition', 'compound_statement', 'template_declaration'])
    },
    'c_sharp': {
        wasmName: 'tree-sitter-c_sharp.wasm',
        definitions: {
            'class_declaration': 'Class',
            'interface_declaration': 'Interface',
            'enum_declaration': 'Enum',
            'struct_declaration': 'Struct',
            'method_declaration': 'Method',
            'property_declaration': 'Property',
            'namespace_declaration': 'Namespace'
        },
        containers: new Set(['compilation_unit', 'namespace_declaration', 'class_declaration', 'interface_declaration', 'struct_declaration', 'declaration_list'])
    },

    /** Java/Kotlin family */
    'java': {
        wasmName: 'tree-sitter-java.wasm',
        definitions: {
            'class_declaration': 'Class',
            'interface_declaration': 'Interface',
            'enum_declaration': 'Enum',
            'method_declaration': 'Method',
            'constructor_declaration': 'Constructor',
            'field_declaration': 'Field'
        },
        containers: new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'program', 'class_body'])
    },
    'kotlin': {
        wasmName: 'tree-sitter-kotlin.wasm',
        definitions: {
            'class_declaration': 'Class',
            'object_declaration': 'Object',
            'function_declaration': 'Function',
            'property_declaration': 'Property'
        },
        containers: new Set(['source_file', 'class_declaration', 'class_body'])
    },

    /** Python */
    'python': {
        wasmName: 'tree-sitter-python.wasm',
        definitions: {
            'class_definition': 'Class',
            'function_definition': 'Function'
        },
        containers: new Set(['class_definition', 'module', 'block'])
    },

    /** Go/Rust family */
    'go': {
        wasmName: 'tree-sitter-go.wasm',
        definitions: {
            'function_declaration': 'Func',
            'method_declaration': 'Method',
            'type_declaration': 'Type',
            'const_declaration': 'Const',
            'var_declaration': 'Var'
        },
        containers: new Set(['source_file', 'type_declaration', 'type_spec'])
    },
    'rust': {
        wasmName: 'tree-sitter-rust.wasm',
        definitions: {
            'function_item': 'Fn',
            'struct_item': 'Struct',
            'enum_item': 'Enum',
            'trait_item': 'Trait',
            'impl_item': 'Impl',
            'mod_item': 'Mod',
            'const_item': 'Const',
            'static_item': 'Static'
        },
        containers: new Set(['source_file', 'impl_item', 'mod_item', 'declaration_list'])
    },

    /** Shell/Scripting languages */
    'bash': {
        wasmName: 'tree-sitter-bash.wasm',
        definitions: {
            'function_definition': 'Function',
            'variable_assignment': 'Variable'
        },
        containers: new Set(['program'])
    },
    'lua': {
        wasmName: 'tree-sitter-lua.wasm',
        definitions: {
            'function_declaration': 'Function',
            'variable_declaration': 'Variable'
        },
        containers: new Set(['program', 'block', 'chunk'])
    },
    'ruby': {
        wasmName: 'tree-sitter-ruby.wasm',
        definitions: {
            'class': 'Class',
            'module': 'Module',
            'method': 'Method',
            'singleton_method': 'Method'
        },
        containers: new Set(['program', 'class', 'module', 'method', 'do_block'])
    },
    'php': {
        wasmName: 'tree-sitter-php.wasm',
        definitions: {
            'class_declaration': 'Class',
            'interface_declaration': 'Interface',
            'trait_declaration': 'Trait',
            'function_definition': 'Function',
            'method_declaration': 'Method'
        },
        containers: new Set(['program', 'class_declaration', 'interface_declaration', 'trait_declaration', 'class_interface_clause'])
    },

    /** Mobile development */
    'swift': {
        wasmName: 'tree-sitter-swift.wasm',
        definitions: {
            'class_declaration': 'Class',
            'struct_declaration': 'Struct',
            'enum_declaration': 'Enum',
            'protocol_declaration': 'Protocol',
            'extension_declaration': 'Extension',
            'function_declaration': 'Function'
        },
        containers: new Set(['source_file', 'class_declaration', 'struct_declaration', 'extension_declaration'])
    },
    'dart': {
        wasmName: 'tree-sitter-dart.wasm',
        definitions: {
            'class_definition': 'Class',
            'mixin_declaration': 'Mixin',
            'enum_declaration': 'Enum',
            'function_signature': 'Function'
        },
        containers: new Set(['program', 'class_definition', 'class_body'])
    },
    'objc': {
        wasmName: 'tree-sitter-objc.wasm',
        definitions: {
            'class_interface': 'Interface',
            'class_implementation': 'Implementation',
            'protocol_declaration': 'Protocol',
            'method_declaration': 'Method'
        },
        containers: new Set(['translation_unit', 'class_interface', 'class_implementation'])
    },

    /** Configuration/Data formats */
    'json': {
        wasmName: 'tree-sitter-json.wasm',
        definitions: {
            'pair': 'Key'
        },
        containers: new Set(['document', 'object'])
    },
    'yaml': {
        wasmName: 'tree-sitter-yaml.wasm',
        definitions: {
            'block_mapping_pair': 'Key'
        },
        containers: new Set(['stream', 'document', 'block_mapping', 'block_node'])
    },
    'toml': {
        wasmName: 'tree-sitter-toml.wasm',
        definitions: {
            'table': 'Table',
            'pair': 'Key'
        },
        containers: new Set(['document', 'table'])
    },
    'css': {
        wasmName: 'tree-sitter-css.wasm',
        definitions: {
            'rule_set': 'Rule',
            'media_statement': 'Media',
            'keyframes_statement': 'Keyframes'
        },
        containers: new Set(['stylesheet', 'media_statement', 'block'])
    },

    /** Functional/Other languages */
    'elixir': {
        wasmName: 'tree-sitter-elixir.wasm',
        definitions: {
            'call': 'Call'
        },
        containers: new Set(['source_file', 'call', 'do_block'])
    },
    'elm': {
        wasmName: 'tree-sitter-elm.wasm',
        definitions: {
            'type_declaration': 'Type',
            'type_alias_declaration': 'Type',
            'function_declaration_left': 'Function'
        },
        containers: new Set(['file'])
    },
    'ocaml': {
        wasmName: 'tree-sitter-ocaml.wasm',
        definitions: {
            'value_definition': 'Value',
            'type_definition': 'Type',
            'module_definition': 'Module'
        },
        containers: new Set(['compilation_unit', 'module_definition', 'struct'])
    },
    'scala': {
        wasmName: 'tree-sitter-scala.wasm',
        definitions: {
            'class_definition': 'Class',
            'object_definition': 'Object',
            'trait_definition': 'Trait',
            'function_definition': 'Function'
        },
        containers: new Set(['compilation_unit', 'class_definition', 'template_body'])
    },
    'zig': {
        wasmName: 'tree-sitter-zig.wasm',
        definitions: {
            'function_declaration': 'Function',
            'variable_declaration': 'Variable'
        },
        containers: new Set(['source_file', 'container_declaration'])
    },
    'solidity': {
        wasmName: 'tree-sitter-solidity.wasm',
        definitions: {
            'contract_declaration': 'Contract',
            'interface_declaration': 'Interface',
            'library_declaration': 'Library',
            'function_definition': 'Function'
        },
        containers: new Set(['source_unit', 'contract_body'])
    },

    /** Minimal support for other languages */
    'elisp': {
        wasmName: 'tree-sitter-elisp.wasm',
        definitions: { 'function_definition': 'Function' },
        containers: new Set(['program'])
    },
    'ql': {
        wasmName: 'tree-sitter-ql.wasm',
        definitions: { 'class_declaration': 'Class', 'predicate_declaration': 'Predicate' },
        containers: new Set(['module', 'class_body'])
    },
    'rescript': {
        wasmName: 'tree-sitter-rescript.wasm',
        definitions: { 'let_binding': 'Let', 'type_declaration': 'Type' },
        containers: new Set(['source_file'])
    },
    'systemrdl': {
        wasmName: 'tree-sitter-systemrdl.wasm',
        definitions: { 'component_def': 'Component' },
        containers: new Set(['source_file', 'component_body'])
    },
    'tlaplus': {
        wasmName: 'tree-sitter-tlaplus.wasm',
        definitions: { 'operator_definition': 'Operator', 'module_definition': 'Module' },
        containers: new Set(['source_file', 'module'])
    },
    'embedded_template': {
        wasmName: 'tree-sitter-embedded_template.wasm',
        definitions: {},
        containers: new Set([])
    },
    'html': {
        wasmName: 'tree-sitter-html.wasm',
        definitions: { 'element': 'Element', 'script_element': 'Script', 'style_element': 'Style' },
        containers: new Set(['document', 'element'])
    }
};

/**
 * Maps file extensions to their corresponding language IDs.
 * Used to determine the appropriate Tree-sitter parser for a given file.
 * @type {Record<string, string>}
 * @example EXT_TO_LANG['.ts'] // returns 'typescript'
 */
export const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.hpp': 'cpp',
    '.cc': 'cpp',
    '.cs': 'c_sharp',
    '.css': 'css',
    '.sh': 'bash',
    '.bash': 'bash',
    '.rb': 'ruby',
    '.erb': 'embedded_template',
    '.php': 'php',
    '.lua': 'lua',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.dart': 'dart',
    '.m': 'objc',
    '.mm': 'objc',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.vue': 'vue',
    '.html': 'html',
    '.htm': 'html',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.elm': 'elm',
    '.ml': 'ocaml',
    '.mli': 'ocaml',
    '.scala': 'scala',
    '.sc': 'scala',
    '.zig': 'zig',
    '.sol': 'solidity',
    '.el': 'elisp',
    '.ql': 'ql',
    '.qll': 'ql',
    '.res': 'rescript',
    '.resi': 'rescript',
    '.rdl': 'systemrdl',
    '.tla': 'tlaplus'
};
