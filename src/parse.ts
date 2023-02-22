import { parse } from "@babel/parser"
import { VariableDeclaration, ObjectExpression, ObjectProperty, Expression, AssignmentExpression, MemberExpression, BinaryExpression, StringLiteral, Identifier, ArrayExpression } from "@babel/types"
import { log } from "./log"
import { ProtobufEnum, ProtobufMessage, ProtobufProperties, ProtobufProperty, ProtobufRoot, SpecProperty } from "./types/protobuf"
import { writeProtobuf } from "./write"
import * as fs from "fs"

type DemangledName = {
    split: string[]
    type: keyof ProtobufRoot
}

type CachedDefault = {
    path: DemangledName,
    name: string,
    value: string
}

const parseMainScript = (script: string) => {
    const versionMatch = /VERSION="(?<version>\d*\.\d*\.\d*)"/g.exec(script)

    if (!versionMatch?.groups) throw new Error("couldnt find version")
    const version = versionMatch.groups["version"]
    log("info", `found version "${version}"`)

    const buildMatch = /BUILD_ID="(?<build>\d*)"/g.exec(script)

    if (!buildMatch?.groups) throw new Error("couldnt find build")
    const build = buildMatch.groups["build"]
    log("info", `found build "${build}"`)

    const parsed = parse(script)

    if (parsed.program.body.length != 1) throw new Error("program body length is not 1")

    // Program -> ExpressionStatement
    const firstStatement = parsed.program.body[0]
    if (firstStatement.type !== "ExpressionStatement") throw new Error("first statement is not an expression statement")

    // ExpressionStatement -> CallExpression
    const statementExpression = firstStatement.expression
    if (statementExpression.type !== "CallExpression") throw new Error("first statement expression is not an call expression")
    if (statementExpression.arguments.length != 1) throw new Error("first statement expression arguments length is not 1")

    // CallExpression -> ArrayExpression
    const expressionArguments = statementExpression.arguments[0]
    if (expressionArguments.type !== "ArrayExpression") throw new Error("expression argument is not an array expression")

    // ArrayExpression -> ObjectExpression
    const objectExpression = expressionArguments.elements.find(element => element?.type == "ObjectExpression") as ObjectExpression
    if (!objectExpression) throw new Error("couldnt find object expression")

    // 12345: (a, b, c) => {
    //
    // ObjectProperty that has a NumericLiteral key, and an ArrowFunctionExpression as value
    const arrows = objectExpression.properties.filter(property => {
        if (property.type != "ObjectProperty" ||
            property.key.type != "NumericLiteral" ||
            property.value.type != "ArrowFunctionExpression" ||
            property.value.body.type != "BlockStatement") return false

        // a.b = c,
        // d.internalSpec = { ... }
        //
        // we are looking for a sequence (because there"s a comma after the assign)
        // in that sequence, we are looking for an assignment of "internalSpec"
        return property.value.body.body.some(statement => {
            if (statement.type != "ExpressionStatement" ||
                statement.expression.type != "SequenceExpression") return false

            return statement.expression.expressions.some(expression => {
                if (expression.type != "AssignmentExpression" ||
                    expression.left.type != "MemberExpression" ||
                    expression.left.property.type != "Identifier") return false

                return expression.left.property.name == "internalSpec"
            })
        })
    }) as SpecProperty[]

    log("info", `found ${arrows.length} spec functions`)

    parseSpecObjects(arrows)
}

const parseSpecObjects = (objects: SpecProperty[]) => {
    const protobuf: ProtobufRoot = {
        messages: new Map(),
        enums: new Map()
    }

    //a$b$cSpec -> { split: ["a", "b", "c"], type: "messages" }
    const demangle = (name: string): DemangledName => {
        let specSuffix = false
        if (name.endsWith("Spec")) {
            specSuffix = true
            name = name.slice(0, -4)
        }
        return {
            split: name.split("$"),
            type: specSuffix ? "messages" : "enums"
        }
    }

    const setProtobufEnum = (demangled: DemangledName, value: ProtobufEnum) => {
        let current: ProtobufRoot = protobuf
        const last = demangled.split.length - 1

        for (let index = 0; index < last; index++) {
            const name = demangled.split[index];
            if (!current.messages.has(name)) return log("fatal", `message "${name}" not declared`)
            current = current.messages.get(name)!
        }

        current.enums.set(demangled.split[last], value)
    }


    const setProtobufDefault = (def: CachedDefault) => {
        let current: ProtobufMessage | null = null
        const { path: demangled } = def

        for (let index = 0; index < demangled.split.length; index++) {
            const name = demangled.split[index];
            if (!current) {
                if (!protobuf.messages.has(name)) return log("fatal", `message "${name}" not declared`)
                current = protobuf.messages.get(name)!
            } else {
                if (!current.messages.has(name)) return log("fatal", `message "${name}" not declared`)
                current = current.messages.get(name)!
            }
        }

        const property = current!.properties.get(def.name)
        if (!property) return log("fatal", `property "${def.name}" not declared`)
        current!.properties.set(def.name, {
            ...property,
            default: def.value
        })
    }

    const setProtobufProperties = (demangled: DemangledName, value: ProtobufProperties) => {
        let current: ProtobufMessage | null = null

        for (let index = 0; index < demangled.split.length; index++) {
            const name = demangled.split[index];
            if (!current) {
                if (!protobuf.messages.has(name)) return log("fatal", `message "${name}" not declared`)
                current = protobuf.messages.get(name)!
            } else {
                if (!current.messages.has(name)) return log("fatal", `message "${name}" not declared`)
                current = current.messages.get(name)!
            }
        }

        current!.oneofs = value.oneofs
        current!.properties = value.properties
    }

    let messagesTotal = 0
    let enumsTotal = 0
    let propertiesTotal = 0

    for (const func of objects) {
        log("info", `parsing function "${func.key.value}"`)

        let messagesCount = 0
        let enumsCount = 0
        let propertiesCount = 0

        const declaredSpecs: Map<string, ProtobufEnum | null> = new Map()
        const assignedSpecs: Map<string, DemangledName> = new Map()
        const defaults: CachedDefault[] = []

        const getHierarchalDemangledPath = (from: DemangledName, to: DemangledName) => {
            if (from.split.length >= to.split.length) return to.split

            for (let index = 0; index < from.split.length; index++) {
                if (from.split[index] != to.split[index]) return to.split.slice(index)
            }

            return to.split
        }

        const addToProtobuf = (demangled: DemangledName) => {
            let current: ProtobufRoot = protobuf

            for (let index = 0; index < demangled.split.length; index++) {
                const name = demangled.split[index];
                if (index == demangled.split.length - 1) {
                    if (demangled.type == "enums") {
                        if (current.enums.has(name)) return
                        enumsCount++

                        current.enums.set(name, [])
                        return
                    } else {
                        if (current.messages.has(name)) return
                    }
                }

                if (!current.messages.has(name)) {
                    messagesCount++

                    current.messages.set(name, {
                        messages: new Map(),
                        enums: new Map(),
                        properties: new Map(),
                        oneofs: new Map()
                    })
                }
                current = current.messages.get(name)!
            }
        }

        const nextVoidAssignmentStatement = (expression: AssignmentExpression) => {
            if (expression.left.type != "MemberExpression") return log("fatal", `unknown "${expression.left.type}" at spec nulling`)
            if (expression.left.property.type != "Identifier") return log("fatal", `unknown property "${expression.left.property.type}" at spec nulling`)

            const { property } = expression.left
            const demangledName = demangle(property.name)
            addToProtobuf(demangledName)

            if (expression.right.type == "AssignmentExpression") nextVoidAssignmentStatement(expression.right)
        }

        //a.internalDefaults = {
        //  b: 1
        //}
        //
        //store them in a map, to assign them later
        //we dont know if the spec has already been declared or not
        const parseInternalDefaults = (name: DemangledName, properties: ObjectExpression["properties"]) => {
            for (const property of properties) {
                if (property.type != "ObjectProperty") return log("fatal", `unknown property "${property.type}" at internal defaults`)
                if (property.key.type != "Identifier") return log("fatal", `unknown key "${property.key.type}" at internal defaults`)

                let defaultValue: string | null = null

                switch (property.value.type) {
                    case "NumericLiteral": {
                        // a = 1
                        defaultValue = property.value.value.toString()
                        break
                    }
                    case "MemberExpression": {
                        // a = b.c
                        //
                        // we want c
                        const { property: propertyValue } = property.value
                        if (propertyValue.type != "Identifier") return log("fatal", `unknown value "${propertyValue.type}" at internal defaults`)
                        defaultValue = propertyValue.name
                        break
                    }
                }

                if (!defaultValue) return log("fatal", `null value "${property.value.type}" at internal defaults`)

                defaults.push({
                    path: name,
                    name: property.key.name,
                    value: defaultValue
                })
            }
        }

        //a.internalSpec = {
        //  b: [1, c.TYPES.STRING]
        //  __oneofs__: {
        //    d: ["b"]
        //  }
        //}
        const parseInternalSpec = (name: DemangledName, properties: ObjectExpression["properties"]) => {
            const props: ProtobufProperties = {
                properties: new Map(),
                oneofs: new Map()
            }

            //check if __oneofs__ exists
            //parameters referenced by oneof are encapsulated inside it
            let jaja = new Map<string, string>()
            const maybeOneOf = properties.find(property =>
                property.type == "ObjectProperty" &&
                property.key.type == "Identifier" &&
                property.key.name == "__oneofs__") as ObjectProperty | undefined

            if (maybeOneOf) {
                if (maybeOneOf.value.type != "ObjectExpression") return log("fatal", `__oneofs__ is not an object expression`)
                const hasGoodProps = maybeOneOf.value.properties.every(property => {
                    if (property.type != "ObjectProperty") return log("fatal", `__oneofs__ property is not an object property`)
                    if (property.key.type != "Identifier") return log("fatal", `__oneofs__ property key is not an identifier`)
                    if (property.value.type != "ArrayExpression") return log("fatal", `__oneofs__ property value is not an array expression`)
                    if (!property.value.elements.every(element => !!element && element.type == "StringLiteral")) return log("fatal", `__oneofs__ property value non string literals`)

                    return true
                })

                if (!hasGoodProps) return


                const oneofProperties = maybeOneOf.value.properties as (ObjectProperty & { key: Identifier, value: ArrayExpression & { elements: StringLiteral[] } })[]
                for (const oneOfProperty of oneofProperties) {
                    props.oneofs.set(oneOfProperty.key.name, [])
                    for (const element of oneOfProperty.value.elements) {
                        jaja.set(element.value, oneOfProperty.key.name)
                    }
                }
            }

            for (const property of properties) {
                let messageProperty: Partial<ProtobufProperty> = {
                    field: "optional"
                }

                if (property.type != "ObjectProperty") {
                    log("warn", `ignoring "${property.type}" at spec value assignment`)
                    continue
                }
                if (property.key.type != "Identifier") {
                    log("warn", `ignoring key "${property.key.type}" at spec value assignment`)
                    continue
                }
                if (property.value.type != "ArrayExpression") {
                    if (property.key.name != "__oneofs__") return log("fatal", `unknown value "${property.value.type}" at spec value assignment`)
                    continue
                }

                const [idExpression, fieldExpression, reference] = property.value.elements
                if (!idExpression || !fieldExpression) return log("fatal", `missing id or type value assignment`)

                if (idExpression.type != "NumericLiteral") return log("fatal", `unknown id "${idExpression.type}" at spec value assignment`)

                messageProperty.id = idExpression.value

                //"a.TYPES.STRING" or "a.FLAGS.REPEATED"
                const parseFlag = (expression: MemberExpression) => {
                    const { property: expressionProperty, object } = expression
                    if (expressionProperty.type != "Identifier") return log("fatal", `unknown property "${expressionProperty.type}" at spec flag`)
                    if (object.type != "MemberExpression") return log("fatal", `unknown object "${object.type}" at spec flag`)
                    if (object.property.type != "Identifier") return log("fatal", `unknown object property "${object.property.type}" at spec flag`)

                    switch (object.property.name) {
                        case "TYPES": {
                            if (expressionProperty.name == "MESSAGE" || expressionProperty.name == "ENUM") {
                                //lets assign them later, this is not the ideal place
                            } else {
                                messageProperty.type = expressionProperty.name.toLowerCase()
                            }
                            break
                        }
                        case "FLAGS": {
                            switch (expressionProperty.name) {
                                case "PACKED": {
                                    messageProperty.packed = true
                                    break
                                }
                                case "REPEATED": {
                                    messageProperty.field = "repeated"
                                    break
                                }
                                case "REQUIRED": {
                                    messageProperty.field = "required"
                                    break
                                }
                                default:
                                    throw new Error(`unknown property name "${expressionProperty.name}" at spec flag`)
                            }
                            break
                        }
                        default:
                            throw new Error(`unknown object name "${object.property.name}" at spec flag`)
                    }
                }

                //"b.TYPES.STRING" or "b.TYPES.STRING | b.FLAGS.REPEATED"
                //one is a single value, the other is a binary expression that must be recursively parsed
                switch (fieldExpression.type) {
                    case "BinaryExpression": {
                        let current: BinaryExpression["left"] = fieldExpression
                        while (current.type == "BinaryExpression") {
                            if (current.right.type == "MemberExpression") {
                                parseFlag(current.right)
                            }
                            if (current.left.type == "MemberExpression") {
                                parseFlag(current.left)
                            }
                            current = current.left
                        }
                        break
                    }
                    case "MemberExpression": {
                        parseFlag(fieldExpression)
                        break
                    }
                    default:
                        throw new Error(`unknown type "${fieldExpression.type}" at spec value assignment`)
                }

                if (!messageProperty.type) {
                    if (!reference) throw new Error(`missing reference at spec value assignment`)

                    switch (reference.type) {
                        //[..., a],
                        //a has been assigned previously
                        case "Identifier": {
                            if (!assignedSpecs.has(reference.name)) throw new Error(`unknown reference "${reference.name}" at spec value assignment`)
                            const path = getHierarchalDemangledPath(name, assignedSpecs.get(reference.name)!)
                            if (path.length == 0) throw new Error("path length is zero")
                            messageProperty.type = path.join(".")

                            break
                        }
                        //[..., a.b],
                        //b is a mangled spec name
                        case "MemberExpression": {
                            if (reference.property.type != "Identifier") throw new Error(`unknown reference property "${reference.property.type}" at spec value assignment`)
                            const specReference = reference.property.name
                            const demangledReference = demangle(specReference)
                            const path = getHierarchalDemangledPath(name, demangledReference)
                            if (path.length == 0) throw new Error("path length is zero")
                            messageProperty.type = path.join(".")

                            break
                        }
                        default:
                            throw new Error(`unknown reference type "${reference.type}" at spec value assignment`)
                    }
                }

                //if the property is referenced by a oneof, it is not a property
                if (jaja.has(property.key.name)) {
                    const oneofName = jaja.get(property.key.name)!

                    props.oneofs.get(oneofName)!.push({
                        id: messageProperty.id,
                        name: property.key.name,
                        type: messageProperty.type
                    })
                } else {
                    props.properties.set(property.key.name, messageProperty as ProtobufProperty)
                }
            }

            propertiesCount += props.properties.size

            setProtobufProperties(name, props)
        }

        //const a = b(12345)({
        //  c: 0,
        //  d: 1
        //});
        //
        //we want to get the "c" and "d" values, since they declare the enum
        const parseDeclaration = (declaration: VariableDeclaration) => {
            if (declaration.kind != "const") return log("fatal", `unknown "${declaration.kind}" at declaration`)
            if (declaration.declarations.length != 1) return log("fatal", `unexpected multiple declarations (expected 1)`)

            const { id, init } = declaration.declarations[0]
            if (id.type != "Identifier") return log("fatal", `unknown id "${id.type}" at declaration`)
            if (!init) return log("fatal", "unknown declaration without init")

            if (init.type == "ObjectExpression" && init.properties.length == 0) {
                //a = {};
                //
                //early return, this is a useless declaration
                declaredSpecs.set(id.name, null)
                return
            }

            if (init.type != "CallExpression") {
                return log("fatal", `unknown init "${init.type}" at declaration`)
            }

            const { callee } = init
            if (callee.type == "SequenceExpression") {
                //a = (0, i.default)({}, null);
                //
                //early return, this is a useless declaration
                declaredSpecs.set(id.name, null)
                return
            }

            if (init.arguments.length != 1) return log("fatal", `unknown argument length "${init.arguments.length}" at declaration`)

            const { arguments: [argument] } = init
            if (argument.type != "ObjectExpression") return log("warn", `ignoring argument "${argument.type}" at declaration`)

            const localEnum: ProtobufEnum = []
            for (const property of argument.properties) {
                if (property.type != "ObjectProperty") return log("fatal", `unknown property "${property.type}" at property declaration`)
                if (property.key.type != "Identifier") return log("fatal", `unknown key "${property.key.type}" at property declaration`)
                if (property.value.type != "NumericLiteral") return log("fatal", `unknown value "${property.value.type}" at property declaration`)

                localEnum.push({
                    name: property.key.name,
                    id: property.value.value
                })
            }

            declaredSpecs.set(id.name, localEnum)
        }

        //const a = b
        //c.d = a
        //
        //we need to correlate the "a" with the "c.d" assignment
        //those are set in the "parseDeclaration" function
        const parseAssignment = (assignment: AssignmentExpression) => {
            if (assignment.left.type != "MemberExpression") return log("fatal", `unknown left "${assignment.left.type}" at assignment`)
            if (assignment.left.property.type != "Identifier") return log("fatal", `unknown property "${assignment.left.property.type}" at assignment`)
            if (assignment.right.type != "Identifier") return log("fatal", `unknown right "${assignment.right.type}" at assignment`)

            const { name } = assignment.right
            if (!declaredSpecs.has(name)) throw new Error(`unknown declaration "${name}" at assignment`)

            const { property } = assignment.left
            const demangledName = demangle(property.name)

            const declared = declaredSpecs.get(name)
            if (declared) setProtobufEnum(demangledName, declared)

            assignedSpecs.set(name, demangledName)
        }

        //sequences are statements joined by ","
        //there are two types of sequences observed:
        // 1. spec nulling
        // - setting evertyhing to void 0
        // 2. internal spec assignment
        // - setting the message properties
        const parseSequenceExpressions = (expressions: Expression[]) => {
            //a defineProperty call exists before nulling
            const specNulling = expressions.some(expression => {
                if (expression.type == "CallExpression") {
                    let what: string | undefined
                    if (expression.callee.type == "MemberExpression") {
                        const { object, property } = expression.callee
                        if (object.type == "Identifier" && property.type == "Identifier")
                            what = `${object.name}.${property.name}`
                    }

                    log("info", `found ${what ? `"${what}"` : "unknown"} call, infering spec nulling`)
                    return true
                }
                return false
            })

            //t.a = t.b = void 0
            if (specNulling) {
                for (const expression of expressions) {
                    if (expression.type == "AssignmentExpression") {
                        nextVoidAssignmentStatement(expression)
                        continue
                    }
                }
            } else {
                //other useless assignments can be mixed in
                for (const expression of expressions) {
                    if (expression.type != "AssignmentExpression") {
                        log("warn", `ignoring "${expression.type}" at spec assignment`)
                        continue
                    }
                    if (expression.left.type != "MemberExpression") {
                        log("warn", `ignoring left "${expression.left.type}" at spec assignment`)
                        continue
                    }
                    if (expression.right.type == "Identifier") {
                        parseAssignment(expression)
                        continue
                    } else if (expression.right.type != "ObjectExpression") {
                        log("warn", `ignoring right "${expression.right.type}" at spec assignment`)
                        continue
                    }

                    const { object: leftObject, property: leftProperty } = expression.left
                    if (leftObject.type != "Identifier") {
                        log("warn", `ignoring left object "${leftObject.type}" at spec assignment`)
                        continue
                    }
                    if (leftProperty.type != "Identifier") {
                        log("warn", `ignoring left property "${leftProperty.type}" at spec assignment`)
                        continue
                    }

                    const demangledSpec = assignedSpecs.get(leftObject.name)
                    if (!demangledSpec) throw new Error(`unknown spec "${leftObject.name}" at spec assignment`)

                    switch (leftProperty.name) {
                        //a.internalSpec = { ... }
                        case "internalSpec": {
                            parseInternalSpec(demangledSpec, expression.right.properties)
                            break
                        }
                        //a.internalDefaults = { ... }
                        case "internalDefaults": {
                            parseInternalDefaults(demangledSpec, expression.right.properties)
                            break
                        }
                        default:
                            throw new Error(`unknown left property "${leftProperty.name}" at spec assignment`)
                    }
                }
            }
        }

        for (const statement of func.value.body.body) {
            if (statement.type == "VariableDeclaration" && statement.kind == "var") {
                //silently ignore, this is a useless declaration
                continue
            }

            switch (statement.type) {
                case "ExpressionStatement": {
                    switch (statement.expression.type) {
                        case "AssignmentExpression": {
                            //spec assignments; enums or the empty object function
                            parseAssignment(statement.expression)
                            break
                        }
                        case "SequenceExpression": {
                            // can be the second line where everything is nulled
                            // or the last lines, where they are assigned
                            const { expressions } = statement.expression
                            parseSequenceExpressions(expressions)
                            break
                        }
                    }
                    break
                }
                //const a = something
                //can be an enum or the empty object function
                case "VariableDeclaration": {
                    parseDeclaration(statement)
                    break
                }
            }
        }

        for (const def of defaults) {
            setProtobufDefault(def)
        }

        log("info", `parsing metrics:\n- ${messagesCount} messages\n- ${enumsCount} enums\n- ${propertiesCount} properties`)
        messagesTotal += messagesCount
        enumsTotal += enumsCount
        propertiesTotal += propertiesCount
    }

    log("info", `total metrics:\n- ${messagesTotal} messages\n- ${enumsTotal} enums\n- ${propertiesTotal} properties`)

    writeProtobuf(protobuf)
}


const existingFile = fs.existsSync("app.js")
if (!existingFile) {
    log("fatal", `"app.js" does not exist`)
} else {
    log("info", `"app.js" already exists, parsing`)
    parseMainScript(fs.readFileSync("app.js", "utf-8"))
}