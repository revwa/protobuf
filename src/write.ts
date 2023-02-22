import { ProtobufEnum, ProtobufMessage, ProtobufOneOf, ProtobufProperty, ProtobufRoot } from "./types/protobuf"
import * as fs from "fs"

export const writeProtobuf = (protobuf: ProtobufRoot) => {
    let identation = 0
    const step = 4

    let document: string = `syntax = "proto2";\npackage whatsapp;`

    const writeLine = (line: string) => document += `\n${" ".repeat(identation)}${line}`
    const writeBlankLine = () => document += "\n"


    const messageKeys = [...Array.from(protobuf.messages.keys())].map(key => ({ key, type: "message" as const }))
    const enumKeys = [...Array.from(protobuf.enums.keys())].map(key => ({ key, type: "enum" as const }))
    const allKeys = [...messageKeys, ...enumKeys].sort((a, b) => a.key.localeCompare(b.key))

    const writeProtobufEnum = (name: string, value: ProtobufEnum) => {
        writeLine(`enum ${name} {`)
        identation += step
        const sorted = value.sort((a, b) => a.id - b.id)
        for (const entry of sorted) {
            writeLine(`${entry.name} = ${entry.id};`)
        }
        identation -= step
        writeLine(`}`)
    }

    const writeProtobufMessage = (name: string, message: ProtobufMessage) => {
        writeLine(`message ${name} {`)
        identation += step

        type ParsedProperty = ({
            key: string
            value: ProtobufProperty
            type: "property"
        } | {
            key: string
            lowestId: number
            value: ProtobufOneOf
            type: "oneof"
        })

        //properties and oneofs, messages, enums
        let sortedProperties: ParsedProperty[] = Array.from(message.properties.entries())
            .map(([key, value]) => ({ key, value, type: "property" as const }))

        if (!!message.oneofs.size) {
            const oneofs = Array.from(message.oneofs.entries())
            for (const [key, value] of oneofs) {
                if (!value.length) continue

                const sortedOneOf = value.sort((a, b) => a.id - b.id)
                sortedProperties.push({
                    key,
                    lowestId: sortedOneOf[0].id,
                    type: "oneof" as const,
                    value: sortedOneOf
                })
            }
        }

        sortedProperties = sortedProperties.sort((a, b) => {
            const getId = (entry: ParsedProperty) => {
                switch (entry.type) {
                    case "property": return entry.value.id
                    case "oneof": return entry.lowestId
                }
            }

            return getId(a) - getId(b)
        })

        for (let i = 0; i < sortedProperties.length; i++) {
            const { key, value, type } = sortedProperties[i]
            switch (type) {
                case "oneof": {
                    if (i != 0) writeBlankLine()
                    writeLine(`oneof ${key} {`)
                    identation += step
                    for (const option of value) {
                        writeLine(`${option.type} ${option.name} = ${option.id};`)
                    }
                    identation -= step
                    writeLine(`}`)
                    if (i != sortedProperties.length - 1) writeBlankLine()
                    break
                }
                case "property": {
                    writeLine(`${value.field} ${value.type} ${key} = ${value.id}${value.packed ? " [packed = true]" : ""}${typeof value.default != "undefined" ? ` [default = ${value.default}]` : ""};`)
                    break
                }
            }
        }


        const sortedMessages = Array.from(message.messages.keys())
            .sort((a, b) => a.localeCompare(b))

        for (const key of sortedMessages) {
            writeBlankLine()
            const messageValue = message.messages.get(key)!
            writeProtobufMessage(key, messageValue)
        }

        const sortedEnums = Array.from(message.enums.keys())
            .sort((a, b) => a.localeCompare(b))

        for (const key of sortedEnums) {
            writeBlankLine()
            const enumValue = message.enums.get(key)!
            writeProtobufEnum(key, enumValue)
        }

        identation -= step
        writeLine(`}`)
    }

    for (const { key, type } of allKeys) {
        writeBlankLine()
        switch (type) {
            case "message": {
                const keyMessage = protobuf.messages.get(key)!
                writeProtobufMessage(key, keyMessage)
                break
            }
            case "enum": {
                const keyEnum = protobuf.enums.get(key)!
                writeProtobufEnum(key, keyEnum)
                break
            }
        }
    }

    fs.writeFileSync("whatsapp.proto", document)
}