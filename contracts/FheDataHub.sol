pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract FheDataHubFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60;
    bool public paused = false;

    struct Batch {
        uint256 id;
        uint256 dataCount;
        bool closed;
    }

    uint256 public currentBatchId = 1;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => mapping(uint256 => euint32)) public encryptedData; // batchId => index => data

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 index, bytes32 ciphertext);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 averageValue);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        _openNewBatch(); // Open initial batch
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldown;
        emit CooldownSecondsSet(oldCooldown, newCooldown);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused(); // Already unpaused or trying to unpause when not paused
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function _openNewBatch() internal {
        batches[currentBatchId] = Batch({id: currentBatchId, dataCount: 0, closed: false});
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner whenNotPaused {
        if (batches[currentBatchId].id != currentBatchId || batches[currentBatchId].closed) revert InvalidBatch();
        batches[currentBatchId].closed = true;
        emit BatchClosed(currentBatchId);
        currentBatchId++;
        _openNewBatch();
    }

    function submitData(euint32 encryptedValue) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        Batch storage currentBatch = batches[currentBatchId];
        if (currentBatch.closed || currentBatch.id != currentBatchId) {
            revert BatchClosedOrInvalid();
        }

        uint256 index = currentBatch.dataCount;
        encryptedData[currentBatchId][index] = encryptedValue;
        currentBatch.dataCount++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, currentBatchId, index, encryptedValue.toBytes32());
    }

    function requestAverageCalculation(uint256 batchId) external whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        Batch storage batch = batches[batchId];
        if (batch.id != batchId || batch.dataCount == 0) {
            revert InvalidBatch();
        }

        uint256 count = batch.dataCount;
        euint32 encryptedSum = FHE.asEuint32(0);
        euint32[] memory ctsArray = new euint32[](count);

        for (uint256 i = 0; i < count; i++) {
            euint32 dataPoint = encryptedData[batchId][i];
            _initIfNeeded(dataPoint);
            encryptedSum = encryptedSum.add(dataPoint);
            ctsArray[i] = dataPoint;
        }
        _initIfNeeded(encryptedSum);

        bytes32 stateHash = _hashCiphertexts(ctsArray);
        uint256 requestId = FHE.requestDecryption(abi.encodePacked(encryptedSum), this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        DecryptionContext memory ctx = decryptionContexts[requestId];
        Batch storage batch = batches[ctx.batchId];
        if (batch.id != ctx.batchId || batch.dataCount == 0) {
            revert InvalidBatch();
        }

        // State Verification
        uint256 count = batch.dataCount;
        euint32[] memory currentCts = new euint32[](count);
        for (uint256 i = 0; i < count; i++) {
            currentCts[i] = encryptedData[ctx.batchId][i];
        }
        bytes32 currentHash = _hashCiphertexts(currentCts);
        if (currentHash != ctx.stateHash) {
            revert StateMismatch();
        }

        // Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // Decode & Finalize
        uint32 sum = abi.decode(cleartexts, (uint32));
        uint256 averageValue = batch.dataCount > 0 ? (sum / uint32(batch.dataCount)) : 0;

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, averageValue);
    }

    function _hashCiphertexts(euint32[] memory cts) internal pure returns (bytes32) {
        bytes32[] memory ctsAsBytes = new bytes32[](cts.length);
        for (uint i = 0; i < cts.length; i++) {
            ctsAsBytes[i] = cts[i].toBytes32();
        }
        return keccak256(abi.encode(ctsAsBytes, address(this)));
    }

    function _initIfNeeded(euint32 v) internal {
        if (!v.isInitialized()) {
            v.init();
        }
    }

    function _requireInitialized(euint32 v) internal pure {
        if (!v.isInitialized()) {
            revert("Ciphertext not initialized");
        }
    }
}